import dotenv from "dotenv";
import QuickBooks from "node-quickbooks";
import OAuthClient from "intuit-oauth";
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve .env relative to the installed module (../../.env from dist/clients/).
// Use override: true so that values from .env always win over any empty-string
// placeholders a host app (e.g. Claude Desktop) may inject via its env config.
dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), override: true });

process.on('uncaughtException', (err) => {
  console.error('[auth-server] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[auth-server] unhandledRejection:', reason);
});

// ── Multi-account profile support ────────────────────────────────────────────

export interface AccountProfile {
  label?: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  realmId?: string;
  environment?: string;
  redirectUri?: string;
}

let accountsRegistry: Record<string, AccountProfile> = {};
let activeAccountName = 'default';

function loadAccountsRegistry(): Record<string, AccountProfile> {
  const accountsPath = path.join(__dirname, '..', '..', 'accounts.json');
  if (!fs.existsSync(accountsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
  } catch (err) {
    console.error('[qbo-client] Failed to parse accounts.json:', err);
    return {};
  }
}

accountsRegistry = loadAccountsRegistry();

// Resolve startup credentials: QUICKBOOKS_ACCOUNT → accounts.json profile,
// otherwise fall back to individual QUICKBOOKS_* env vars.
function resolveStartupConfig(): { profile: AccountProfile; name: string } {
  const accountName = process.env.QUICKBOOKS_ACCOUNT;
  if (accountName && accountsRegistry[accountName]) {
    return { profile: accountsRegistry[accountName], name: accountName };
  }
  // env-var fallback (backwards compatible)
  const profile: AccountProfile = {
    clientId:     process.env.QUICKBOOKS_CLIENT_ID     ?? '',
    clientSecret: process.env.QUICKBOOKS_CLIENT_SECRET ?? '',
    refreshToken: process.env.QUICKBOOKS_REFRESH_TOKEN,
    realmId:      process.env.QUICKBOOKS_REALM_ID,
    environment:  process.env.QUICKBOOKS_ENVIRONMENT   ?? 'sandbox',
    redirectUri:  process.env.QUICKBOOKS_REDIRECT_URI  ?? 'http://localhost:8000/callback',
  };
  // If accounts.json has entries but no QUICKBOOKS_ACCOUNT is set, use the first one
  const firstKey = Object.keys(accountsRegistry)[0];
  if (firstKey && !accountName) {
    activeAccountName = firstKey;
    return { profile: accountsRegistry[firstKey], name: firstKey };
  }
  return { profile, name: 'default' };
}

const startup = resolveStartupConfig();
activeAccountName = startup.name;

const { clientId: client_id, clientSecret: client_secret, redirectUri: redirect_uri } = startup.profile;

if (!client_id || !client_secret) {
  throw Error("Client ID and Client Secret must be set in accounts.json or environment variables");
}

// ── QuickbooksClient ─────────────────────────────────────────────────────────

export class QuickbooksClient {
  private clientId: string;
  private clientSecret: string;
  private refreshToken?: string;
  private realmId?: string;
  private environment: string;
  private accessToken?: string;
  private accessTokenExpiry?: Date;
  private quickbooksInstance?: QuickBooks;
  private oauthClient: OAuthClient;
  private isAuthenticating: boolean = false;
  private redirectUri: string;

  private static readonly TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

  private refreshInFlight?: Promise<{ access_token: string; expires_in: number }>;
  private authInFlight?: Promise<QuickBooks>;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    refreshToken?: string;
    realmId?: string;
    environment: string;
    redirectUri: string;
  }) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.refreshToken = config.refreshToken;
    this.realmId = config.realmId;
    this.environment = config.environment;
    this.redirectUri = config.redirectUri;
    this.oauthClient = new OAuthClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      environment: this.environment,
      redirectUri: this.redirectUri,
    });
  }

  // ── Account switching ──────────────────────────────────────────────────────

  reconfigure(name: string, profile: AccountProfile): void {
    this.clientId     = profile.clientId;
    this.clientSecret = profile.clientSecret;
    this.refreshToken = profile.refreshToken;
    this.realmId      = profile.realmId;
    this.environment  = profile.environment  ?? 'production';
    this.redirectUri  = profile.redirectUri  ?? 'http://localhost:8000/callback';
    activeAccountName = name;

    // Reset all cached auth state
    this.accessToken      = undefined;
    this.accessTokenExpiry = undefined;
    this.quickbooksInstance = undefined;
    this.refreshInFlight  = undefined;
    this.authInFlight     = undefined;
    this.isAuthenticating = false;

    this.oauthClient = new OAuthClient({
      clientId:     this.clientId,
      clientSecret: this.clientSecret,
      environment:  this.environment,
      redirectUri:  this.redirectUri,
    });
  }

  static switchAccount(name: string): { success: boolean; message: string; label?: string; realmId?: string } {
    const profile = accountsRegistry[name];
    if (!profile) {
      const available = Object.keys(accountsRegistry).join(', ') || '(none)';
      return { success: false, message: `Account "${name}" not found in accounts.json. Available: ${available}` };
    }
    quickbooksClient.reconfigure(name, profile);
    return {
      success: true,
      message: `Switched to "${profile.label ?? name}"`,
      label: profile.label ?? name,
      realmId: profile.realmId,
    };
  }

  static listAccounts(): Array<{ name: string; label: string; realmId: string; environment: string; active: boolean }> {
    return Object.entries(accountsRegistry).map(([name, p]) => ({
      name,
      label:       p.label       ?? name,
      realmId:     p.realmId     ?? 'N/A',
      environment: p.environment ?? 'production',
      active:      name === activeAccountName,
    }));
  }

  static getActiveAccountName(): string {
    return activeAccountName;
  }

  static reloadAccountsRegistry(): void {
    accountsRegistry = loadAccountsRegistry();
  }

  // ── OAuth helpers ──────────────────────────────────────────────────────────

  private isTokenExpiredOrExpiringSoon(): boolean {
    if (!this.accessToken || !this.accessTokenExpiry) return true;
    return this.accessTokenExpiry <= new Date(Date.now() + QuickbooksClient.TOKEN_REFRESH_BUFFER_MS);
  }

  private async startOAuthFlow(): Promise<void> {
    if (this.isAuthenticating) return;

    this.isAuthenticating = true;
    const port = 8000;

    const flowClient = new OAuthClient({
      clientId:     this.clientId,
      clientSecret: this.clientSecret,
      environment:  this.environment,
      redirectUri:  `http://localhost:${port}/callback`,
    });

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        console.log(`[auth-server] ${req.method} ${req.url}`);

        if (!req.url?.startsWith('/callback')) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found. Waiting for QuickBooks OAuth callback at /callback');
          return;
        }

        try {
          const response = await flowClient.createToken(req.url);
          const tokens = response.token;

          this.refreshToken = tokens.refresh_token;
          this.realmId = tokens.realmId;
          this.saveTokensToEnv();

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                font-family: Arial, sans-serif;
                background-color: #f5f5f5;
              ">
                <h2 style="color: #2E8B57;">✓ Successfully connected to QuickBooks!</h2>
                <p>You can close this window now.</p>
              </body>
            </html>
          `);

          setTimeout(() => {
            server.close();
            this.isAuthenticating = false;
            resolve();
          }, 1000);
        } catch (error) {
          console.error('Error during token creation:', error);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                font-family: Arial, sans-serif;
                background-color: #fff0f0;
              ">
                <h2 style="color: #d32f2f;">Error connecting to QuickBooks</h2>
                <p>Please check the console for more details.</p>
              </body>
            </html>
          `);
          this.isAuthenticating = false;
          reject(error);
        }
      });

      server.listen(port, '::', async () => {
        const addr = server.address();
        console.log(`[auth-server] Listening on ${typeof addr === 'string' ? addr : `${addr?.address}:${addr?.port}`} (family: ${typeof addr === 'object' ? addr?.family : 'n/a'})`);

        const authUri = flowClient.authorizeUri({
          scope: [OAuthClient.scopes.Accounting as string],
          state: 'testState'
        }).toString();

        console.log('\n=== QuickBooks Authorization ===');
        console.log('Open this URL in a browser to authorize:\n');
        console.log(authUri);
        console.log('\nWaiting for callback...\n');

        try {
          await open(authUri);
        } catch {
          // Headless environment — user will open the URL manually
        }
      });

      server.on('error', (error) => {
        console.error('Server error:', error);
        this.isAuthenticating = false;
        reject(error);
      });
    });
  }

  private saveTokensToEnv(): void {
    const tokenPath = path.join(__dirname, '..', '..', '.env');
    const envContent = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf-8') : '';
    const envLines = envContent.split('\n');

    const updateEnvVar = (name: string, value: string) => {
      const index = envLines.findIndex(line => line.startsWith(`${name}=`));
      if (index !== -1) {
        envLines[index] = `${name}=${value}`;
      } else {
        envLines.push(`${name}=${value}`);
      }
    };

    if (this.refreshToken) updateEnvVar('QUICKBOOKS_REFRESH_TOKEN', this.refreshToken);
    if (this.realmId) updateEnvVar('QUICKBOOKS_REALM_ID', this.realmId);

    const tmpPath = `${tokenPath}.tmp.${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, envLines.join('\n'), { mode: 0o600 });
      fs.renameSync(tmpPath, tokenPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      throw err;
    }
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      await this.startOAuthFlow();
      if (!this.refreshToken) {
        throw new Error('Failed to obtain refresh token from OAuth flow');
      }
    }

    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        const authResponse = await this.oauthClient.refreshUsingToken(this.refreshToken!);

        const token = authResponse.token as unknown as {
          access_token: string;
          expires_in?: number;
          refresh_token?: string;
          x_refresh_token_expires_in?: number;
        };

        this.accessToken = token.access_token;
        const expiresIn = token.expires_in || 3600;
        this.accessTokenExpiry = new Date(Date.now() + expiresIn * 1000);

        const newRefreshToken = token.refresh_token;
        if (newRefreshToken && newRefreshToken !== this.refreshToken) {
          this.refreshToken = newRefreshToken;
          // Persist rotated token to accounts.json if this account is registered there
          if (accountsRegistry[activeAccountName]) {
            accountsRegistry[activeAccountName].refreshToken = newRefreshToken;
            try {
              const accountsPath = path.join(__dirname, '..', '..', 'accounts.json');
              fs.writeFileSync(accountsPath, JSON.stringify(accountsRegistry, null, 2), { mode: 0o600 });
              console.error(`[qbo-client] Refresh token rotated and persisted to accounts.json (${activeAccountName})`);
            } catch (persistErr) {
              console.error('[qbo-client] Failed to persist rotated refresh token to accounts.json:', persistErr);
            }
          } else {
            try {
              this.saveTokensToEnv();
              console.error('[qbo-client] Refresh token rotated and persisted to .env');
            } catch (persistErr) {
              console.error('[qbo-client] Failed to persist rotated refresh token:', persistErr);
            }
          }
        }

        const refreshExpiresIn = token.x_refresh_token_expires_in;
        if (typeof refreshExpiresIn === 'number' && refreshExpiresIn < 14 * 24 * 3600) {
          const days = Math.round(refreshExpiresIn / 86400);
          console.error(`[qbo-client] WARNING: refresh token expires in ~${days} day(s). Re-run \`npm run auth\` before it expires.`);
        }

        return { access_token: this.accessToken!, expires_in: expiresIn };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to refresh Quickbooks token: ${message}`);
      } finally {
        this.refreshInFlight = undefined;
      }
    })();

    return this.refreshInFlight;
  }

  async authenticate(): Promise<QuickBooks> {
    if (this.authInFlight) return this.authInFlight;

    this.authInFlight = (async () => {
      try {
        if (!this.refreshToken || !this.realmId) {
          await this.startOAuthFlow();
          if (!this.refreshToken || !this.realmId) {
            throw new Error('Failed to obtain required tokens from OAuth flow');
          }
        }

        if (this.isTokenExpiredOrExpiringSoon()) {
          try {
            await this.refreshAccessToken();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[qbo-client] Token refresh failed (${message}); falling back to interactive OAuth`);
            this.refreshToken = undefined;
            this.accessToken = undefined;
            this.accessTokenExpiry = undefined;
            await this.refreshAccessToken();
          }
        }

        this.quickbooksInstance = new QuickBooks(
          this.clientId,
          this.clientSecret,
          this.accessToken!,
          false,
          this.realmId!,
          this.environment === 'sandbox',
          false,
          null,
          '2.0',
          this.refreshToken
        );

        return this.quickbooksInstance;
      } finally {
        this.authInFlight = undefined;
      }
    })();

    return this.authInFlight;
  }

  static async getInstance(): Promise<QuickBooks> {
    if (quickbooksClient.isTokenExpiredOrExpiringSoon()) {
      await quickbooksClient.authenticate();
    }
    if (!quickbooksClient.quickbooksInstance) {
      await quickbooksClient.authenticate();
    }
    return quickbooksClient.quickbooksInstance!;
  }

  static async getAuthCredentials(): Promise<{ accessToken: string; realmId: string; isSandbox: boolean }> {
    if (quickbooksClient.isTokenExpiredOrExpiringSoon() || !quickbooksClient.accessToken) {
      await quickbooksClient.authenticate();
    }
    if (!quickbooksClient.accessToken || !quickbooksClient.realmId) {
      throw new Error('Quickbooks not authenticated');
    }
    return {
      accessToken: quickbooksClient.accessToken,
      realmId: quickbooksClient.realmId,
      isSandbox: quickbooksClient.environment === 'sandbox',
    };
  }

  getQuickbooks() {
    if (!this.quickbooksInstance) {
      throw new Error('Quickbooks not authenticated. Call authenticate() first');
    }
    return this.quickbooksInstance;
  }
}

export const quickbooksClient = new QuickbooksClient({
  clientId:     startup.profile.clientId,
  clientSecret: startup.profile.clientSecret,
  refreshToken: startup.profile.refreshToken,
  realmId:      startup.profile.realmId,
  environment:  startup.profile.environment  ?? 'sandbox',
  redirectUri:  startup.profile.redirectUri  ?? 'http://localhost:8000/callback',
});

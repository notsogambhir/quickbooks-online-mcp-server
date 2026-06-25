import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "switch_qbo_account";
const toolDescription =
  "Switch the active QuickBooks Online account. All subsequent QBO tool calls will use the new account until switched again. Use list_qbo_accounts to see available account names.";
const toolSchema = z.object({
  account_name: z.string().describe("The account key from accounts.json (e.g. 'vp-associates')"),
});

const toolHandler = async ({ params }: any) => {
  const result = QuickbooksClient.switchAccount(params.account_name);
  if (!result.success) {
    return { content: [{ type: "text" as const, text: `Error: ${result.message}` }] };
  }
  return {
    content: [{
      type: "text" as const,
      text: `${result.message}\nRealm ID: ${result.realmId ?? 'N/A'}\n\nAll subsequent QuickBooks calls now target this account.`,
    }],
  };
};

export const SwitchQboAccountTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};

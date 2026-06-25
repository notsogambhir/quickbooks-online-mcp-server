import { QuickbooksClient } from "../clients/quickbooks-client.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { z } from "zod";

const toolName = "list_qbo_accounts";
const toolDescription = "List all QuickBooks Online accounts configured in accounts.json, showing which one is currently active.";
const toolSchema = z.object({});

const toolHandler = async () => {
  const accounts = QuickbooksClient.listAccounts();
  if (accounts.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: "No accounts found in accounts.json. Add your accounts to accounts.json (see accounts.json.example for the format).",
      }],
    };
  }
  const rows = accounts.map(a =>
    `${a.active ? '▶' : ' '} ${a.name} — ${a.label} (realm: ${a.realmId}, env: ${a.environment})`
  ).join('\n');
  return {
    content: [{
      type: "text" as const,
      text: `Configured QBO accounts (▶ = active):\n\n${rows}`,
    }],
  };
};

export const ListQboAccountsTool: ToolDefinition<typeof toolSchema> = {
  name: toolName,
  description: toolDescription,
  schema: toolSchema,
  handler: toolHandler,
};

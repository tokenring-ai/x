import { AgentCommandService } from "@tokenring-ai/agent";
import type { TokenRingPlugin } from "@tokenring-ai/app";
import { requireSecret } from "@tokenring-ai/secrets/SecretService";
import { z } from "zod";
import agentCommands from "./commands.ts";
import packageJSON from "./package.json" with { type: "json" };
import { type ResolvedXAccountConfig, XServiceConfigSchema } from "./schema.ts";
import XService from "./XService.ts";

const packageConfigSchema = z.object({
  x: XServiceConfigSchema.prefault({ accounts: {} }),
});

export default {
  name: packageJSON.name,
  displayName: "X (Twitter) Integration",
  version: packageJSON.version,
  description: packageJSON.description,
  install(app) {
    app.addService(new XService(app));
    app.waitForService(AgentCommandService, commandService => {
      commandService.addAgentCommands(agentCommands);
    });
  },
  async reconfigure(app, config) {
    // Resolve up front so a misconfigured token fails at configure, not on first poll.
    const resolvedAccounts: Record<string, ResolvedXAccountConfig> = {};
    for (const [accountName, account] of Object.entries(config.x.accounts)) {
      resolvedAccounts[accountName] = {
        ...account,
        accessToken: requireSecret(app, account.accessToken, `X account "${accountName}" access token`),
      };
    }

    await app.requireService(XService).reconfigure({ accounts: resolvedAccounts });
  },
  configSchema: packageConfigSchema,
} satisfies TokenRingPlugin<typeof packageConfigSchema>;

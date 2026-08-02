import { CommandFailedError } from "@tokenring-ai/agent/AgentError";
import type { AgentCommandInputSchema, AgentCommandInputType, TokenRingAgentCommand } from "@tokenring-ai/agent/types";
import { type ConfigLayer, ConfigurationService } from "@tokenring-ai/app";

const inputSchema = {
  args: {
    name: {
      description: "The name to save the X account under",
      type: "string",
      defaultValue: "x",
    },
    save: {
      description: "Where to save the X account configuration",
      type: "enum",
      values: ["user", "project"],
      defaultValue: "user",
    },
  },
  positionals: [
    {
      name: "accessToken",
      description: "OAuth 2.0 user-context access token for the X account",
      required: false,
    },
  ],
} as const satisfies AgentCommandInputSchema;

export default {
  name: "connect x",
  alias: "x connect",
  description: "Connects an X (Twitter) account for bot messaging",
  inputSchema,
  execute: async ({ agent, args: { accessToken, name, save } }: AgentCommandInputType<typeof inputSchema>): Promise<string> => {
    if (!agent.headless && !accessToken) {
      accessToken =
        (await agent.askForText({
          message: "What is the OAuth 2.0 user-context access token for the X account you want to connect?",
          label: "Access Token",
          masked: true,
        })) ?? undefined;
    }

    if (!accessToken) throw new CommandFailedError("Usage: /connect x <accessToken>");

    const configService = agent.requireService(ConfigurationService);
    const overrides = configService.getOverrides(save);
    const x = (overrides.x ?? {}) as { accounts?: Record<string, unknown> };
    const accounts = x.accounts ?? {};
    const existingAccount = (accounts[name] ?? {}) as Record<string, unknown>;
    const next = {
      ...overrides,
      x: {
        ...x,
        accounts: {
          ...accounts,
          [name]: {
            ...existingAccount,
            accessToken,
          },
        },
      },
    } satisfies ConfigLayer;

    const result = await configService.apply(save, next);
    if (!result.ok) {
      throw new CommandFailedError(result.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
    }

    return `X account "${name}" connected.`;
  },
  help: `Connect an X (Twitter) account and save its access token in the configuration.

Requires an OAuth 2.0 user-context access token with tweet.read, tweet.write,
users.read, dm.read, and dm.write scopes (as needed for the features you use).

When run interactively, the token is requested using a masked prompt.

## Example

/connect x --name=x`,
} satisfies TokenRingAgentCommand<typeof inputSchema>;

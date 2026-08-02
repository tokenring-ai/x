import type { ConfigFieldMeta } from "@tokenring-ai/app/config/metadata";
import { secret, type WithResolvedSecrets } from "@tokenring-ai/secrets/secret";
import z from "zod";

/**
 * An X (Twitter) user account used as a messaging transport. What the account
 * *does* — who may talk to it, which agent answers — is configured on the bot
 * that uses it, in the `bot` plugin.
 *
 * Requires an OAuth 2.0 user-context access token with scopes such as
 * `tweet.read`, `tweet.write`, `users.read`, `dm.read`, and `dm.write`.
 */
export const XAccountConfigSchema = z.object({
  accessToken: secret({ description: "OAuth 2.0 user-context access token (Bearer)" }),
  baseUrl: z
    .string()
    .default("https://api.x.com")
    .meta({ advanced: true, description: "X API base URL" } satisfies ConfigFieldMeta),
  userAgent: z
    .string()
    .default("TokenRing-One/1.0 (https://github.com/tokenring-ai/one)")
    .meta({ advanced: true, description: "User-Agent header sent with X API requests" } satisfies ConfigFieldMeta),
  pollIntervalMs: z
    .number()
    .int()
    .min(5_000)
    .default(20_000)
    .meta({
      advanced: true,
      description: "How often, in milliseconds, to poll for new mentions and DMs",
    } satisfies ConfigFieldMeta),
  maxMessageLength: z
    .number()
    .int()
    .min(1)
    .max(25_000)
    .default(280)
    .meta({
      advanced: true,
      description: "Longest single post or DM the account will send. Free accounts are capped at 280; Premium long-form allows more",
    } satisfies ConfigFieldMeta),
  pollMentions: z
    .boolean()
    .default(true)
    .meta({ advanced: true, description: "Poll the mentions timeline for inbound public messages" } satisfies ConfigFieldMeta),
  pollDirectMessages: z
    .boolean()
    .default(true)
    .meta({ advanced: true, description: "Poll DM events for inbound direct messages" } satisfies ConfigFieldMeta),
});

export type ParsedXAccountConfig = z.output<typeof XAccountConfigSchema>;

/** An account as handed to the service, with its token secret already resolved. */
export type ResolvedXAccountConfig = WithResolvedSecrets<ParsedXAccountConfig, "accessToken">;

export const XServiceConfigSchema = z
  .object({
    accounts: z
      .record(z.string(), XAccountConfigSchema)
      .default({})
      .meta({ label: "Accounts", description: "X accounts, keyed by the service name bots address them by" } satisfies ConfigFieldMeta),
  })
  .meta({ label: "X", description: "X (Twitter) accounts for bot messaging" } satisfies ConfigFieldMeta);

export type ParsedXServiceConfig = z.output<typeof XServiceConfigSchema>;

/** Service config with every account's secrets resolved. */
export type ResolvedXServiceConfig = { accounts: Record<string, ResolvedXAccountConfig> };

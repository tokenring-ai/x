import { describe, expect, it } from "bun:test";
import { type ParsedXServiceConfig, XAccountConfigSchema, XServiceConfigSchema } from "../schema.ts";

describe("X service configuration", () => {
  it("validates multiple accounts", () => {
    const result = XServiceConfigSchema.safeParse({
      accounts: {
        primary: { accessToken: "primary-token" },
        support: { accessToken: "support-token", pollIntervalMs: 30_000, maxMessageLength: 4000 },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accounts.primary!.pollIntervalMs).toBe(20_000);
      expect(result.data.accounts.primary!.maxMessageLength).toBe(280);
      expect(result.data.accounts.support!.pollIntervalMs).toBe(30_000);
      expect(result.data.accounts.support!.maxMessageLength).toBe(4000);
    }
  });

  it("defaults to no accounts", () => {
    expect(XServiceConfigSchema.parse({})).toEqual({ accounts: {} });
  });

  it("applies the account defaults", () => {
    expect(XAccountConfigSchema.parse({ accessToken: "token" })).toEqual({
      accessToken: "token",
      baseUrl: "https://api.x.com",
      userAgent: "TokenRing-One/1.0 (https://github.com/tokenring-ai/one)",
      pollIntervalMs: 20_000,
      maxMessageLength: 280,
      pollMentions: true,
      pollDirectMessages: true,
    });
  });

  it("rejects a poll interval below the minimum", () => {
    const result = XAccountConfigSchema.safeParse({ accessToken: "token", pollIntervalMs: 1000 });
    expect(result.success).toBe(false);
  });

  it("infers parsed config type from schema output", () => {
    const config: ParsedXServiceConfig = {
      accounts: {
        default: {
          accessToken: "token",
          baseUrl: "https://api.x.com",
          userAgent: "test",
          pollIntervalMs: 10_000,
          maxMessageLength: 280,
          pollMentions: true,
          pollDirectMessages: false,
        },
      },
    };

    expect(config.accounts.default!.pollDirectMessages).toBe(false);
  });
});

import { describe, expect, it } from "bun:test";
import { createConnectHarness } from "@tokenring-ai/secrets/test/connectHarness";
import { VAULT_LOCKED_MESSAGE } from "@tokenring-ai/secrets/vaultCredentials";
import command from "./x.ts";

const TOKEN = "x-secret-token-value";

function run(harness: ReturnType<typeof createConnectHarness>, args: Record<string, unknown> = {}) {
  return command.execute({ agent: harness.agent, args: { name: "work", save: "workspace", ...args } } as never);
}

describe("/connect x", () => {
  it("saves the token to the vault and only references it in settings", async () => {
    const harness = createConnectHarness({ answers: [TOKEN] });
    const output = await run(harness);

    expect(harness.prompts.map(prompt => prompt.masked)).toEqual([true]);
    expect(harness.vault.entries.x).toEqual({ "work.accessToken": TOKEN });
    expect(harness.configuration.overrides.workspace).toEqual({
      x: { accounts: { work: { accessToken: { source: "vault", category: "x", key: "work.accessToken" } } } },
    });
    expect(harness.settingsContain(TOKEN)).toBe(false);
    expect(output).not.toContain(TOKEN);
  });

  it("accepts the token as an argument when nobody can answer a prompt", async () => {
    const harness = createConnectHarness({ nobodyToAsk: true });
    await run(harness, { accessToken: TOKEN, save: "global" });
    expect(harness.vault.entries.x).toEqual({ "work.accessToken": TOKEN });
    expect(harness.settingsContain(TOKEN)).toBe(false);
    expect(harness.configuration.overrides.global).toHaveProperty("x.accounts.work.accessToken.source", "vault");
  });

  it("refuses when the vault is locked, saving nothing and asking for nothing", async () => {
    const harness = createConnectHarness({ answers: [TOKEN] });
    harness.vault.writable = false;
    await expect(run(harness)).rejects.toThrow(VAULT_LOCKED_MESSAGE);
    expect(harness.prompts).toEqual([]);
    expect(harness.vault.entries).toEqual({});
    expect(harness.configuration.overrides.workspace).toEqual({});
  });

  it("puts the vault back when the settings can't be saved", async () => {
    const harness = createConnectHarness();
    harness.vault.entries.x = { "work.accessToken": "previous-token" };
    harness.configuration.reject = "invalid";
    const error = await run(harness, { accessToken: TOKEN }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(harness.vault.entries.x).toEqual({ "work.accessToken": "previous-token" });
    expect(harness.configuration.overrides.workspace).toEqual({});
  });

  it("removes a new vault entry when the settings can't be saved", async () => {
    const harness = createConnectHarness();
    harness.configuration.reject = "invalid";
    await expect(run(harness, { accessToken: TOKEN })).rejects.toThrow("invalid");
    expect(harness.vault.entries.x).toEqual({});
  });
});

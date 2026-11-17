import { describe, expect, it, mock } from "bun:test";
import type TokenRingApp from "@tokenring-ai/app";
import XRpcSchema from "../rpc/schema.ts";
import xRPC from "../rpc/x.ts";
import XService from "../XService.ts";

function fakeApp() {
  const createPost = mock(async (text: string, options: { account?: string; replyToTweetId?: string } = {}) => ({
    id: "99",
    account: options.account ?? "brand",
    text,
  }));
  const x = {
    getAvailableAccounts: () => ["brand", "alt"],
    getProvider: (name: string) => (name === "brand" ? { maxMessageLength: 280 } : name === "alt" ? { maxMessageLength: 25_000 } : undefined),
    createPost,
  };
  // Only the X service is available: anything reaching for ChatService or permissions would throw.
  const requireService = mock((service: unknown) => {
    if (service === XService) return x;
    throw new Error("unexpected service");
  });
  return { app: { requireService } as unknown as TokenRingApp, createPost, requireService };
}

describe("X RPC", () => {
  it("lists connected accounts with their length limits", async () => {
    const { app } = fakeApp();
    expect(await xRPC.methods.listAccounts.execute({}, app)).toEqual({
      status: "success",
      accounts: [
        { name: "brand", maxMessageLength: 280 },
        { name: "alt", maxMessageLength: 25_000 },
      ],
    });
  });

  it("posts through the same service call as the agent tool, without agent approval", async () => {
    const { app, createPost, requireService } = fakeApp();
    const result = await xRPC.methods.createPost.execute({ text: "Hello", account: "brand" }, app);
    expect(createPost).toHaveBeenCalledWith("Hello", { account: "brand" });
    expect(result).toEqual({ status: "success", account: "brand", id: "99", url: "https://x.com/i/status/99" });
    expect(requireService.mock.calls.every(([service]) => service === XService)).toBe(true);
  });

  it("surfaces the service's failure to the caller", async () => {
    const { app, createPost } = fakeApp();
    createPost.mockRejectedValueOnce(new Error('X account "nope" is not connected'));
    await expect(xRPC.methods.createPost.execute({ text: "Hello", account: "nope" }, app)).rejects.toThrow("not connected");
  });

  it("declares the methods the Social app calls", () => {
    expect(Object.keys(XRpcSchema.methods)).toEqual(["listAccounts", "createPost"]);
  });
});

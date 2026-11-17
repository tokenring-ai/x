import { describe, expect, it, mock } from "bun:test";
import type Agent from "@tokenring-ai/agent/Agent";
import ChatService from "@tokenring-ai/chat/ChatService";
import { permissionSlug } from "@tokenring-ai/chat/permissions/permissionIds";
import createPost from "../tools/createPost.ts";
import XService from "../XService.ts";

function fakeAgent(approve: boolean, account: string) {
  const checkToolApproval = mock(async (_options: { safetyLevel: number; permission?: { id: string; summary: string } }) => approve);
  const x = {
    resolveAccountName: () => account,
    getProvider: () => ({ maxMessageLength: 280 }),
    createPost: mock(async () => ({ id: "1" })),
  };
  const agent = {
    requireService: (service: unknown) => (service === ChatService ? { checkToolApproval } : service === XService ? x : undefined),
    infoMessage: () => {},
  } as unknown as Agent;
  return { agent, checkToolApproval, x };
}

describe("x_createPost permission", () => {
  it("names a permission for the slugged account, at level 8", async () => {
    const { agent, checkToolApproval } = fakeAgent(true, "My Brand.Co");
    await createPost.execute(createPost.inputSchema.parse({ text: "hello" }), agent);
    const options = checkToolApproval.mock.calls[0]?.[0];
    expect(options?.permission).toEqual({ id: `x.${permissionSlug("My Brand.Co")}.post`, summary: "Post on X as My Brand.Co" });
    expect(options?.safetyLevel).toBe(8);
  });

  it("posts nothing when declined", async () => {
    const { agent, x } = fakeAgent(false, "brand");
    await expect(createPost.execute(createPost.inputSchema.parse({ text: "hello" }), agent)).rejects.toThrow(/did not approve/);
    expect(x.createPost).not.toHaveBeenCalled();
  });
});

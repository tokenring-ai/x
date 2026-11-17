import type TokenRingApp from "@tokenring-ai/app";
import { createRPCEndpoint } from "@tokenring-ai/rpc/createRPCEndpoint";
import XService from "../XService.ts";
import XRpcSchema from "./schema.ts";

export default createRPCEndpoint(XRpcSchema, {
  listAccounts(_args, app: TokenRingApp) {
    const x = app.requireService(XService);
    const accounts = x.getAvailableAccounts().flatMap(name => {
      const provider = x.getProvider(name);
      return provider ? [{ name, maxMessageLength: provider.maxMessageLength }] : [];
    });
    return { status: "success", accounts };
  },

  async createPost({ text, account, replyToTweetId }, app: TokenRingApp) {
    // Same service call as the x_createPost agent tool, minus the agent approval: clicking Post is the approval.
    const post = await app.requireService(XService).createPost(text, { ...(account && { account }), ...(replyToTweetId && { replyToTweetId }) });
    return { status: "success", account: post.account, id: post.id, url: `https://x.com/i/status/${encodeURIComponent(post.id)}` };
  },
});

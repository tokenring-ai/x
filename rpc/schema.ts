import type { RPCSchema } from "@tokenring-ai/rpc/types";
import { SuccessSchema } from "@tokenring-ai/rpc/types";
import { z } from "zod";

/**
 * Browser-safe: the web app bundles this file, so it imports only zod and the RPC types.
 * Posting here is a person clicking Post in the Social app, which is itself the approval:
 * these methods do not go through agent tool approval and create no permission grants.
 */
export default {
  name: "X RPC",
  path: "/rpc/x",
  methods: {
    /** Connected X accounts, with each account's post length limit. */
    listAccounts: {
      type: "query",
      input: z.object({}),
      result: SuccessSchema.extend({
        accounts: z.array(z.object({ name: z.string(), maxMessageLength: z.number() })),
      }),
    },
    /** Publishes a public post from a connected account. It cannot be unsent. */
    createPost: {
      type: "mutation",
      input: z.object({
        text: z.string().min(1),
        account: z.string().min(1).exactOptional(),
        replyToTweetId: z.string().min(1).exactOptional(),
      }),
      result: SuccessSchema.extend({
        account: z.string(),
        id: z.string(),
        /** Link to the post. X returns only the id, so this is the canonical status link built from it. */
        url: z.string(),
      }),
    },
  },
} satisfies RPCSchema;

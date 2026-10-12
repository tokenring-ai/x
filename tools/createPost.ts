import type Agent from "@tokenring-ai/agent/Agent";
import ChatService from "@tokenring-ai/chat/ChatService";
import type { TokenRingToolDefinition, TokenRingToolResult } from "@tokenring-ai/chat/schema";
import { ToolCallError } from "@tokenring-ai/chat/util/tokenRingTool";
import intelligentTruncate from "@tokenring-ai/utility/string/intelligentTruncate";
import { z } from "zod";
import XService from "../XService.ts";

const name = "x_createPost";
const displayName = "X/createPost";
const description =
  "Publish a post from a connected X account, optionally as a reply to a tweet. The post is public and cannot be unsent, so it always goes through approval.";

/** A public post cannot be unsent. */
const SAFETY_LEVEL = 7;

const inputSchema = z.object({
  text: z.string().min(1).describe("Post text"),
  account: z.string().min(1).exactOptional().describe("Connected X account name. Required when more than one account is connected."),
  replyToTweetId: z.string().min(1).exactOptional().describe("Tweet id to reply to. Omit to publish a new post."),
});

async function execute({ text, account, replyToTweetId }: z.output<typeof inputSchema>, agent: Agent): Promise<TokenRingToolResult> {
  const body = text.trim();
  const replyTo = replyToTweetId?.trim();
  if (!body) throw new ToolCallError(name, "text is required");
  if (replyToTweetId != null && !replyTo) throw new ToolCallError(name, "replyToTweetId is empty");

  const x = agent.requireService(XService);
  let accountName: string;
  try {
    accountName = x.resolveAccountName(account);
  } catch (error) {
    throw new ToolCallError(name, error instanceof Error ? error.message : String(error), { cause: error });
  }

  const provider = x.getProvider(accountName);
  if (!provider) throw new ToolCallError(name, `X account "${accountName}" is not connected`);
  if (body.length > provider.maxMessageLength) {
    throw new ToolCallError(name, `text is longer than the ${accountName} account limit of ${provider.maxMessageLength} characters`);
  }

  const approved = await agent.requireService(ChatService).checkToolApproval(
    {
      toolName: name,
      message: replyTo ? `Reply on X as ${accountName}?` : `Post on X as ${accountName}?`,
      detailedDescription: [
        replyTo
          ? `Publish a public reply to tweet ${replyTo} from the connected X account "${accountName}". It cannot be unsent.`
          : `Publish a public post from the connected X account "${accountName}". It cannot be unsent.`,
        "",
        "Text:",
        intelligentTruncate(body, { maxLength: 2_000 }),
      ].join("\n"),
      safetyLevel: SAFETY_LEVEL,
      default: false,
    },
    agent,
  );

  if (!approved) throw new ToolCallError(name, "User did not approve posting");

  agent.infoMessage(`[${name}] Posting as ${accountName}${replyTo ? ` in reply to ${replyTo}` : ""}`);
  const post = await x.createPost(body, { account: accountName, ...(replyTo ? { replyToTweetId: replyTo } : {}) });

  return {
    message: replyTo ? `**X** Replied as ${accountName}` : `**X** Posted as ${accountName}`,
    result: replyTo ? `Posted reply ${post.id} to ${replyTo} as ${accountName}` : `Posted ${post.id} as ${accountName}`,
  };
}

export default {
  name,
  displayName,
  description,
  inputSchema,
  execute,
} satisfies TokenRingToolDefinition<typeof inputSchema>;

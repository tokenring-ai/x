import { randomUUID } from "node:crypto";
import type Agent from "@tokenring-ai/agent/Agent";
import { permissionSlug } from "@tokenring-ai/chat";
import ChatService from "@tokenring-ai/chat/ChatService";
import type { TokenRingToolDefinition, TokenRingToolResult } from "@tokenring-ai/chat/schema";
import { ToolCallError } from "@tokenring-ai/chat/util/tokenRingTool";
import SchedulerService from "@tokenring-ai/scheduler/SchedulerService";
import { parseAt } from "@tokenring-ai/scheduler/utility/getNextRunTime";
import intelligentTruncate from "@tokenring-ai/utility/string/intelligentTruncate";
import { z } from "zod";
import XService from "../XService.ts";

const name = "x_schedulePost";
const displayName = "X/schedulePost";
const description =
  "Schedule a post from a connected X account to be published later, at a fixed time, without anyone approving it then. " +
  "The exact text is fixed now (no model runs at post time). The post is public and cannot be unsent, so scheduling always goes through approval, " +
  "and it shares the permission of x_createPost: allowing one allows the other. To post now, use x_createPost.";

/** Same as x_createPost: the post reaches people, and the later run is unattended. */
const SAFETY_LEVEL = 8;

const inputSchema = z.object({
  text: z.string().min(1).describe("Post text, exactly as it will be published"),
  at: z
    .string()
    .min(1)
    .describe("When to publish, as an ISO 8601 date and time with a UTC offset, for example 2026-11-20T09:00:00-05:00. Must be in the future."),
  account: z.string().min(1).exactOptional().describe("Connected X account name. Required when more than one account is connected."),
  replyToTweetId: z.string().min(1).exactOptional().describe("Tweet id to reply to. Omit to publish a new post."),
});

async function execute({ text, at, account, replyToTweetId }: z.output<typeof inputSchema>, agent: Agent): Promise<TokenRingToolResult> {
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

  const time = parseAt(at);
  if (time === null) throw new ToolCallError(name, `"${at}" is not a date and time with a UTC offset. Use ISO 8601, for example 2026-11-20T09:00:00-05:00.`);
  if (time <= Date.now()) throw new ToolCallError(name, "The post time must be in the future.");
  const when = new Date(time).toISOString();

  const scheduler = agent.requireService(SchedulerService);

  const approved = await agent.requireService(ChatService).checkToolApproval(
    {
      toolName: name,
      message: replyTo ? `Schedule a reply on X as ${accountName} for ${when}?` : `Schedule a post on X as ${accountName} for ${when}?`,
      detailedDescription: [
        `At ${when} the connected X account "${accountName}" publishes this ${replyTo ? `public reply to tweet ${replyTo}` : "public post"}, with nobody asked again. It cannot be unsent.`,
        "",
        "Text:",
        intelligentTruncate(body, { maxLength: 2_000 }),
      ].join("\n"),
      safetyLevel: SAFETY_LEVEL,
      default: false,
      // The same permission as x_createPost: one "Always allow" covers scheduling and the later run.
      permission: { id: `x.${permissionSlug(accountName)}.post`, summary: `Post on X as ${accountName}` },
    },
    agent,
  );
  if (!approved) throw new ToolCallError(name, "User did not approve scheduling the post");

  const scheduleName = `social-x-${randomUUID().slice(0, 8)}`;
  scheduler.addSchedule(scheduleName, {
    at: when,
    action: {
      kind: "tool",
      agentType: agent.config.agentType,
      tool: "x_createPost",
      input: { text: body, account: accountName, ...(replyTo ? { replyToTweetId: replyTo } : {}) },
    },
  });

  return {
    message: `**X** Scheduled a post as ${accountName} for ${when}`,
    result: `Scheduled ${scheduleName}: ${replyTo ? `reply to ${replyTo}` : "post"} as ${accountName} at ${when}. It publishes without asking again, only if the permission x.${permissionSlug(accountName)}.post is granted at that time.`,
  };
}

export default {
  name,
  displayName,
  description,
  inputSchema,
  execute,
} satisfies TokenRingToolDefinition<typeof inputSchema>;

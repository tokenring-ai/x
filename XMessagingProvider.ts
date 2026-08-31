import type TokenRingApp from "@tokenring-ai/app";
import type { IncomingMessage, IncomingMessageHandler, MessagingProvider, SendOptions } from "@tokenring-ai/bot";
import { HTTPRetriever } from "@tokenring-ai/utility/http/HTTPRetriever";
import { z } from "zod";
import type { ResolvedXAccountConfig } from "./schema.ts";
import type XService from "./XService.ts";

/** Matches the working placeholder ConversationStream posts before real text arrives. */
const WORKING_PLACEHOLDER = /^\*\*\*.*⏳\*\*\*$/;

const XUserSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    name: z.string().optional(),
  })
  .loose();

const XTweetSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    author_id: z.string().optional(),
    conversation_id: z.string().optional(),
    in_reply_to_user_id: z.string().optional(),
    created_at: z.string().optional(),
    referenced_tweets: z
      .array(
        z
          .object({
            type: z.string(),
            id: z.string(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

const XMentionsResponseSchema = z
  .object({
    data: z.array(XTweetSchema).default([]),
    includes: z
      .object({
        users: z.array(XUserSchema).optional(),
      })
      .loose()
      .optional(),
    meta: z
      .object({
        newest_id: z.string().optional(),
        oldest_id: z.string().optional(),
        result_count: z.number().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const XDmEventSchema = z
  .object({
    id: z.string(),
    event_type: z.string(),
    text: z.string().optional(),
    sender_id: z.string().optional(),
    dm_conversation_id: z.string().optional(),
    created_at: z.string().optional(),
  })
  .loose();

const XDmEventsResponseSchema = z
  .object({
    data: z.array(XDmEventSchema).default([]),
    includes: z
      .object({
        users: z.array(XUserSchema).optional(),
      })
      .loose()
      .optional(),
    meta: z
      .object({
        newest_id: z.string().optional(),
        result_count: z.number().optional(),
        next_token: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const XMeResponseSchema = z
  .object({
    data: XUserSchema,
  })
  .loose();

const XCreateTweetResponseSchema = z
  .object({
    data: z
      .object({
        id: z.string(),
        text: z.string().optional(),
      })
      .loose(),
  })
  .loose();

const XCreateDmResponseSchema = z
  .object({
    data: z
      .object({
        dm_conversation_id: z.string().optional(),
        dm_event_id: z.string().optional(),
        id: z.string().optional(),
      })
      .loose(),
  })
  .loose();

/**
 * Conversation ids on this transport are either:
 * - `dm:{conversationId}` / `dm:with:{userId}` for direct messages
 * - `tweet:{conversationId}` for a public reply thread (mentions)
 */
const DM_PREFIX = "dm:";
const DM_WITH_PREFIX = "dm:with:";
const TWEET_PREFIX = "tweet:";
const PENDING_PREFIX = "pending:";

/**
 * One X account, exposed as a messaging transport. It knows how to carry text
 * to and from X (mentions and DMs), and nothing about agents.
 *
 * X has no realtime bot websocket for free accounts, so inbound traffic is
 * polled. Outbound posts that cannot be edited in place (most free accounts)
 * hold the ConversationStream "working..." placeholder locally and post only
 * once real text arrives.
 */
export default class XMessagingProvider implements MessagingProvider {
  readonly maxMessageLength: number;

  private retriever!: HTTPRetriever;
  private userId = "";
  private username = "";
  private handlers = new Set<IncomingMessageHandler>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private stopped = false;

  /** Highest mention tweet id already delivered, so the next poll is incremental. */
  private sinceMentionId: string | undefined;
  /** Highest DM event id already delivered. */
  private sinceDmEventId: string | undefined;
  /** Tweet ids we authored, so replies to them count as addressed. */
  private ownTweetIds = new Set<string>();
  private pendingSeq = 0;
  private pending = new Map<string, { conversationId: string; options?: SendOptions | undefined }>();

  constructor(
    private readonly app: TokenRingApp,
    private readonly service: XService,
    readonly accountName: string,
    private readonly config: ResolvedXAccountConfig,
  ) {
    this.maxMessageLength = config.maxMessageLength;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.retriever = new HTTPRetriever({
      baseUrl: this.config.baseUrl,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": this.config.userAgent,
        Authorization: `Bearer ${this.config.accessToken}`,
      },
      timeout: 15_000,
    });

    const me = await this.retriever.fetchValidatedJson({
      url: "/2/users/me?user.fields=username,name",
      opts: { method: "GET" },
      schema: XMeResponseSchema,
      context: "X current account lookup",
    });
    this.userId = me.data.id;
    this.username = me.data.username;

    this.app.serviceOutput(this.service, `X account ${this.accountName} connected as @${this.username}`);

    // Seed cursors so the first poll only sees traffic from after connect.
    await this.seedCursors();

    this.pollTimer = setInterval(() => {
      void this.poll().catch((error: unknown) => {
        this.app.serviceError(this.service, "X poll error:", error);
      });
    }, this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.handlers.clear();
    this.pending.clear();
    this.ownTweetIds.clear();
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.handlers.add(handler);
  }

  /**
   * A bare user id opens a DM conversation with that user. Tweet and DM
   * conversation ids are already in transport form and pass through.
   */
  resolveConversation(targetId: string): string {
    if (targetId.startsWith(DM_PREFIX) || targetId.startsWith(TWEET_PREFIX)) {
      return targetId;
    }
    return `${DM_WITH_PREFIX}${targetId}`;
  }

  async sendMessage(conversationId: string, text: string, options?: SendOptions): Promise<string> {
    // Hold the bot's "working..." stub locally so free accounts (no tweet edit)
    // never post a placeholder they cannot replace.
    if (WORKING_PLACEHOLDER.test(text.trim())) {
      const pendingId = `${PENDING_PREFIX}${++this.pendingSeq}`;
      this.pending.set(pendingId, { conversationId, options });
      return pendingId;
    }

    return this.post(conversationId, text, options);
  }

  async updateMessage(conversationId: string, messageId: string, text: string): Promise<string> {
    if (messageId.startsWith(PENDING_PREFIX)) {
      const pending = this.pending.get(messageId);
      if (!pending) return messageId;

      if (WORKING_PLACEHOLDER.test(text.trim())) return messageId;

      this.pending.delete(messageId);
      return this.post(pending.conversationId, text, pending.options);
    }

    // Prefer in-place edit when the account can (Premium / Blue within the window).
    try {
      await this.editTweet(messageId, text);
      return messageId;
    } catch {
      // Fall back to a new post so the final answer still lands.
      return this.post(conversationId, text, { replyToMessageId: messageId });
    }
  }

  private async post(conversationId: string, text: string, options?: SendOptions): Promise<string> {
    if (conversationId.startsWith(DM_WITH_PREFIX)) {
      return this.sendDmToUser(conversationId.slice(DM_WITH_PREFIX.length), text);
    }
    if (conversationId.startsWith(DM_PREFIX)) {
      return this.sendDmInConversation(conversationId.slice(DM_PREFIX.length), text);
    }

    const replyTo =
      options?.replyToMessageId && !options.replyToMessageId.startsWith(PENDING_PREFIX)
        ? options.replyToMessageId
        : conversationId.startsWith(TWEET_PREFIX)
          ? conversationId.slice(TWEET_PREFIX.length)
          : undefined;

    return this.createTweet(text, replyTo);
  }

  private async createTweet(text: string, replyToTweetId?: string): Promise<string> {
    const payload: Record<string, unknown> = { text };
    if (replyToTweetId) {
      payload.reply = { in_reply_to_tweet_id: replyToTweetId };
    }

    const response = await this.retriever.fetchValidatedJson({
      url: "/2/tweets",
      opts: { method: "POST", body: JSON.stringify(payload) },
      schema: XCreateTweetResponseSchema,
      context: "X create post",
    });

    this.rememberOwnTweet(response.data.id);
    return response.data.id;
  }

  private async editTweet(tweetId: string, text: string): Promise<void> {
    await this.retriever.fetchValidatedJson({
      url: `/2/tweets/${tweetId}`,
      opts: { method: "PUT", body: JSON.stringify({ text }) },
      schema: XCreateTweetResponseSchema,
      context: "X edit post",
    });
  }

  private async sendDmToUser(userId: string, text: string): Promise<string> {
    const response = await this.retriever.fetchValidatedJson({
      url: `/2/dm_conversations/with/${userId}/messages`,
      opts: { method: "POST", body: JSON.stringify({ text }) },
      schema: XCreateDmResponseSchema,
      context: "X create DM",
    });
    return response.data.dm_event_id ?? response.data.id ?? `dm-sent-${Date.now()}`;
  }

  private async sendDmInConversation(dmConversationId: string, text: string): Promise<string> {
    // One-to-one conversation ids look like "userId1-userId2"; the with-user
    // endpoint is more widely available, so prefer that when we can parse one.
    const otherUserId = otherParticipant(dmConversationId, this.userId);
    if (otherUserId) {
      return this.sendDmToUser(otherUserId, text);
    }

    const response = await this.retriever.fetchValidatedJson({
      url: `/2/dm_conversations/${dmConversationId}/messages`,
      opts: { method: "POST", body: JSON.stringify({ text }) },
      schema: XCreateDmResponseSchema,
      context: "X create DM in conversation",
    });
    return response.data.dm_event_id ?? response.data.id ?? `dm-sent-${Date.now()}`;
  }

  private async seedCursors(): Promise<void> {
    try {
      if (this.config.pollMentions) {
        const params = new URLSearchParams({ max_results: "5", "tweet.fields": "id" });
        const response = await this.retriever.fetchValidatedJson({
          url: `/2/users/${this.userId}/mentions?${params}`,
          opts: { method: "GET" },
          schema: XMentionsResponseSchema,
          context: "X seed mentions cursor",
        });
        this.sinceMentionId = response.meta?.newest_id ?? response.data[0]?.id;
      }
    } catch (error: unknown) {
      this.app.serviceError(this.service, "Could not seed X mentions cursor:", error);
    }

    try {
      if (this.config.pollDirectMessages) {
        const params = new URLSearchParams({ max_results: "5", event_types: "MessageCreate" });
        const response = await this.retriever.fetchValidatedJson({
          url: `/2/dm_events?${params}`,
          opts: { method: "GET" },
          schema: XDmEventsResponseSchema,
          context: "X seed DM cursor",
        });
        this.sinceDmEventId = response.meta?.newest_id ?? response.data[0]?.id;
      }
    } catch (error: unknown) {
      this.app.serviceError(this.service, "Could not seed X DM cursor:", error);
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      if (this.config.pollMentions) await this.pollMentions();
      if (this.config.pollDirectMessages) await this.pollDirectMessages();
    } finally {
      this.polling = false;
    }
  }

  private async pollMentions(): Promise<void> {
    const params = new URLSearchParams({
      max_results: "20",
      expansions: "author_id",
      "tweet.fields": "author_id,conversation_id,created_at,in_reply_to_user_id,referenced_tweets,text",
      "user.fields": "username,name",
    });
    if (this.sinceMentionId) params.set("since_id", this.sinceMentionId);

    const response = await this.retriever.fetchValidatedJson({
      url: `/2/users/${this.userId}/mentions?${params}`,
      opts: { method: "GET" },
      schema: XMentionsResponseSchema,
      context: "X poll mentions",
    });

    if (response.meta?.newest_id) this.sinceMentionId = response.meta.newest_id;

    const users = new Map((response.includes?.users ?? []).map(user => [user.id, user]));
    // API returns newest first; deliver oldest first so conversation order is natural.
    const tweets = [...response.data].reverse();

    for (const tweet of tweets) {
      if (!tweet.author_id || tweet.author_id === this.userId) continue;

      const author = users.get(tweet.author_id);
      const threadId = tweet.conversation_id ?? tweet.id;
      const replyTo = tweet.referenced_tweets?.find(ref => ref.type === "replied_to")?.id;
      const mentioned = this.mentionsUs(tweet.text);
      const repliedToUs = tweet.in_reply_to_user_id === this.userId || (!!replyTo && this.ownTweetIds.has(replyTo));

      const message: IncomingMessage = {
        conversationId: `${TWEET_PREFIX}${threadId}`,
        userId: tweet.author_id,
        userName: author ? displayName(author) : tweet.author_id,
        text: this.stripOwnMention(tweet.text),
        messageId: tweet.id,
        replyToMessageId: replyTo,
        hasAttachments: false,
        // Public mentions are treated as DMs for bot authorization: the bot's
        // directMessages policy (listed / anyone / none) governs who may talk,
        // without requiring a synthetic "channel" configuration on X.
        direct: true,
        addressed: mentioned || repliedToUs,
      };

      await this.emit(message);
    }
  }

  private async pollDirectMessages(): Promise<void> {
    const params = new URLSearchParams({
      max_results: "20",
      event_types: "MessageCreate",
      expansions: "sender_id",
      "dm_event.fields": "id,text,event_type,sender_id,dm_conversation_id,created_at",
      "user.fields": "username,name",
    });
    // dm_events does not support since_id on all tiers; filter client-side after.

    const response = await this.retriever.fetchValidatedJson({
      url: `/2/dm_events?${params}`,
      opts: { method: "GET" },
      schema: XDmEventsResponseSchema,
      context: "X poll DMs",
    });

    const users = new Map((response.includes?.users ?? []).map(user => [user.id, user]));
    const events = [...response.data].reverse();
    let newestSeen = this.sinceDmEventId;

    for (const event of events) {
      if (event.event_type !== "MessageCreate") continue;
      if (!event.sender_id || event.sender_id === this.userId) continue;
      if (!event.dm_conversation_id) continue;
      if (this.sinceDmEventId && !isSnowflakeAfter(event.id, this.sinceDmEventId)) continue;

      const sender = users.get(event.sender_id);
      const message: IncomingMessage = {
        conversationId: `${DM_PREFIX}${event.dm_conversation_id}`,
        userId: event.sender_id,
        userName: sender ? displayName(sender) : event.sender_id,
        text: event.text ?? "",
        messageId: event.id,
        hasAttachments: false,
        direct: true,
        addressed: true,
      };

      await this.emit(message);
      if (!newestSeen || isSnowflakeAfter(event.id, newestSeen)) newestSeen = event.id;
    }

    if (newestSeen) this.sinceDmEventId = newestSeen;
  }

  private async emit(message: IncomingMessage): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(message);
      } catch (error: unknown) {
        this.app.serviceError(this.service, "Error delivering X message to bot handler:", error);
      }
    }
  }

  private mentionsUs(text: string): boolean {
    if (!this.username) return false;
    const mention = new RegExp(`@${escapeRegExp(this.username)}(?![A-Za-z0-9_])`, "i");
    return mention.test(text);
  }

  private stripOwnMention(text: string): string {
    if (!this.username) return text;
    const mention = new RegExp(`@${escapeRegExp(this.username)}(?![A-Za-z0-9_])`, "gi");
    return text
      .replace(mention, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  private rememberOwnTweet(id: string): void {
    this.ownTweetIds.add(id);
    if (this.ownTweetIds.size > 2000) {
      const oldest = this.ownTweetIds.values().next().value;
      if (oldest) this.ownTweetIds.delete(oldest);
    }
  }
}

function displayName(user: z.output<typeof XUserSchema>): string {
  return user.name ? `${user.name} (@${user.username})` : `@${user.username}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One-to-one DM conversation ids are `{id1}-{id2}`; return the other participant. */
function otherParticipant(dmConversationId: string, selfId: string): string | undefined {
  const parts = dmConversationId.split("-");
  if (parts.length !== 2) return undefined;
  if (parts[0] === selfId) return parts[1];
  if (parts[1] === selfId) return parts[0];
  return undefined;
}

/** Snowflake ids are chronological when compared as big integers (or long digit strings). */
function isSnowflakeAfter(id: string, since: string): boolean {
  if (id === since) return false;
  if (id.length !== since.length) return id.length > since.length;
  return id > since;
}

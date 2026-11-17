import type TokenRingApp from "@tokenring-ai/app";
import type { IncomingMessage, IncomingMessageHandler, MessagingProvider, SendOptions } from "@tokenring-ai/bot";
import { HTTPRetriever } from "@tokenring-ai/utility/http/HTTPRetriever";
import { z } from "zod";
import type ProviderStateFile from "./ProviderStateFile.ts";
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
        next_token: z.string().optional(),
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

/** Poll cursors saved between runs, so a restart neither skips nor replays downtime traffic. */
export const XCursorStateSchema = z.object({
  /** The account the cursors belong to; a token for a different account starts fresh. */
  userId: z.string(),
  sinceMentionId: z.string().optional(),
  sinceDmEventId: z.string().optional(),
  mentionsSeeded: z.boolean().default(false),
  dmsSeeded: z.boolean().default(false),
});

export type XCursorStateFile = ProviderStateFile<typeof XCursorStateSchema>;

/** Pages of new mentions or DM events followed in one poll before the rest are given up on. */
const MAX_POLL_PAGES = 10;
const POLL_PAGE_SIZE = 20;

/**
 * The room every public mention belongs to. Mentions are public, so they are channel traffic
 * rather than DMs: a bot answers them when it has a channel whose target is `x:mentions`. Each
 * reply thread still gets its own conversation (`tweet:{conversationId}`).
 */
export const MENTIONS_ROOM = "mentions";

/** Posts and DMs must not be sent twice: retried on a 429 only, never on a 5xx. */
const SEND_ONCE = { idempotent: false } as const;

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
  /** Most accounts cannot edit posts, and an edited public post shows its history: post each part once, when final. */
  readonly editsInPlace = false;

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
  /**
   * Whether each cursor has been set from the live timeline. Until it has, nothing is delivered —
   * without a cursor, the first poll would hand the bot the latest page of old traffic.
   */
  private mentionsSeeded = false;
  private dmsSeeded = false;
  /** Tweet ids we authored, so replies to them count as addressed. */
  private ownTweetIds = new Set<string>();
  private pendingSeq = 0;
  private pending = new Map<string, { conversationId: string; options?: SendOptions | undefined }>();

  constructor(
    private readonly app: TokenRingApp,
    private readonly service: XService,
    readonly accountName: string,
    private readonly config: ResolvedXAccountConfig,
    /** Where cursors persist between runs; without one they live only in memory. */
    private readonly stateFile?: XCursorStateFile,
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

    // Resume from the saved cursors; seed whichever are missing so the first poll only sees
    // traffic from after the first connect.
    this.restoreState();
    await this.seedCursors();

    this.pollTimer = setInterval(() => {
      void this.poll().catch((error: unknown) => {
        if (!this.stopped) this.app.serviceError(this.service, "X poll error:", error);
      });
    }, this.config.pollIntervalMs);
  }

  /**
   * Stops polling. A poll already in flight checks `stopped` before each item, so it delivers
   * nothing further and leaves the cursor on the last item it did deliver.
   */
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

  /** Read through a call: `stop()` flips the flag while a poll is suspended in an await, which narrowing cannot see. */
  private isStopped(): boolean {
    return this.stopped;
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

  /**
   * Publishes a public post on this account. `replyToTweetId` makes it a reply
   * instead of a new post. Bot conversation sends go through sendMessage.
   */
  async createPost(text: string, replyToTweetId?: string): Promise<string> {
    const body = text.trim();
    if (!body) throw new Error("text is required");
    if (body.length > this.maxMessageLength) {
      throw new Error(`text is longer than this account's limit of ${this.maxMessageLength} characters`);
    }
    const reply = replyToTweetId?.trim();
    if (replyToTweetId != null && !reply) throw new Error("replyToTweetId is empty");
    return this.createTweet(body, reply || undefined);
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
      retry: SEND_ONCE,
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
      retry: SEND_ONCE,
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
      retry: SEND_ONCE,
    });
    return response.data.dm_event_id ?? response.data.id ?? `dm-sent-${Date.now()}`;
  }

  private restoreState(): void {
    const saved = this.stateFile?.load();
    if (!saved || saved.userId !== this.userId) return;
    this.sinceMentionId = saved.sinceMentionId;
    this.sinceDmEventId = saved.sinceDmEventId;
    this.mentionsSeeded = saved.mentionsSeeded;
    this.dmsSeeded = saved.dmsSeeded;
  }

  private saveState(): void {
    if (!this.stateFile) return;
    try {
      this.stateFile.save({
        userId: this.userId,
        sinceMentionId: this.sinceMentionId,
        sinceDmEventId: this.sinceDmEventId,
        mentionsSeeded: this.mentionsSeeded,
        dmsSeeded: this.dmsSeeded,
      });
    } catch (error: unknown) {
      this.app.serviceError(this.service, `Could not save X cursors to ${this.stateFile.filePath}:`, error);
    }
  }

  /** Seeds whichever cursors are not seeded yet. A failure is retried by the next poll. */
  private async seedCursors(): Promise<void> {
    if (this.config.pollMentions && !this.mentionsSeeded) {
      try {
        await this.seedMentions();
      } catch (error: unknown) {
        this.app.serviceError(this.service, "Could not seed X mentions cursor (will retry):", error);
      }
    }
    if (this.config.pollDirectMessages && !this.dmsSeeded) {
      try {
        await this.seedDirectMessages();
      } catch (error: unknown) {
        this.app.serviceError(this.service, "Could not seed X DM cursor (will retry):", error);
      }
    }
  }

  private async seedMentions(): Promise<void> {
    const params = new URLSearchParams({ max_results: "5", "tweet.fields": "id" });
    const response = await this.retriever.fetchValidatedJson({
      url: `/2/users/${this.userId}/mentions?${params}`,
      opts: { method: "GET" },
      schema: XMentionsResponseSchema,
      context: "X seed mentions cursor",
    });
    if (this.isStopped()) return;
    this.sinceMentionId = response.meta?.newest_id ?? response.data[0]?.id;
    this.mentionsSeeded = true;
    this.saveState();
  }

  private async seedDirectMessages(): Promise<void> {
    const params = new URLSearchParams({ max_results: "5", event_types: "MessageCreate" });
    const response = await this.retriever.fetchValidatedJson({
      url: `/2/dm_events?${params}`,
      opts: { method: "GET" },
      schema: XDmEventsResponseSchema,
      context: "X seed DM cursor",
    });
    if (this.isStopped()) return;
    this.sinceDmEventId = response.meta?.newest_id ?? response.data[0]?.id;
    this.dmsSeeded = true;
    this.saveState();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      // An unseeded cursor is seeded instead of polled: nothing is delivered until it is.
      if (this.config.pollMentions) await (this.mentionsSeeded ? this.pollMentions() : this.seedMentions());
      if (this.isStopped()) return;
      if (this.config.pollDirectMessages) await (this.dmsSeeded ? this.pollDirectMessages() : this.seedDirectMessages());
    } finally {
      this.polling = false;
    }
  }

  private async pollMentions(): Promise<void> {
    const tweets = new Map<string, z.output<typeof XTweetSchema>>();
    const users = new Map<string, z.output<typeof XUserSchema>>();
    let paginationToken: string | undefined;
    let pages = 0;

    // Newest first, POLL_PAGE_SIZE at a time. With a cursor, follow next_token back to it so a
    // burst of more than one page is delivered whole; without one there is nothing to page back to.
    do {
      const params = new URLSearchParams({
        max_results: String(POLL_PAGE_SIZE),
        expansions: "author_id",
        "tweet.fields": "author_id,conversation_id,created_at,in_reply_to_user_id,referenced_tweets,text",
        "user.fields": "username,name",
      });
      if (this.sinceMentionId) params.set("since_id", this.sinceMentionId);
      if (paginationToken) params.set("pagination_token", paginationToken);

      const response = await this.retriever.fetchValidatedJson({
        url: `/2/users/${this.userId}/mentions?${params}`,
        opts: { method: "GET" },
        schema: XMentionsResponseSchema,
        context: "X poll mentions",
      });
      if (this.isStopped()) return;

      for (const tweet of response.data) tweets.set(tweet.id, tweet);
      for (const user of response.includes?.users ?? []) users.set(user.id, user);
      paginationToken = this.sinceMentionId ? response.meta?.next_token : undefined;
      pages++;
    } while (paginationToken && pages < MAX_POLL_PAGES);

    if (paginationToken) {
      this.app.serviceError(this.service, `More than ${MAX_POLL_PAGES * POLL_PAGE_SIZE} new X mentions arrived since the last poll; the oldest were skipped`);
    }

    // Oldest first, so conversation order is natural and the cursor only ever moves past
    // mentions that were delivered.
    const ordered = [...tweets.values()].sort((a, b) => compareSnowflakes(a.id, b.id));
    for (const tweet of ordered) {
      if (this.isStopped()) return;
      if (tweet.author_id && tweet.author_id !== this.userId) {
        await this.emit(this.mentionMessage(tweet, tweet.author_id, users.get(tweet.author_id)));
      }
      this.sinceMentionId = tweet.id;
      this.saveState();
    }
  }

  private mentionMessage(tweet: z.output<typeof XTweetSchema>, authorId: string, author: z.output<typeof XUserSchema> | undefined): IncomingMessage {
    const threadId = tweet.conversation_id ?? tweet.id;
    const parentId = tweet.referenced_tweets?.find(ref => ref.type === "replied_to")?.id;
    const parentIsOurs = !!parentId && this.ownTweetIds.has(parentId);
    const mentioned = this.mentionsUs(tweet.text);
    const repliedToUs = tweet.in_reply_to_user_id === this.userId || parentIsOurs;

    return {
      conversationId: `${TWEET_PREFIX}${threadId}`,
      roomId: MENTIONS_ROOM,
      userId: authorId,
      userName: author ? displayName(author) : authorId,
      text: this.stripOwnMention(tweet.text),
      messageId: tweet.id,
      // The answer goes under the mention itself; the parent is usually someone else's post.
      replyToMessageId: parentId,
      replyTarget: tweet.id,
      hasAttachments: false,
      // Public, so channel traffic: a stranger is never answered with a public refusal.
      direct: false,
      addressed: mentioned || repliedToUs,
    };
  }

  private async pollDirectMessages(): Promise<void> {
    const events = new Map<string, z.output<typeof XDmEventSchema>>();
    const users = new Map<string, z.output<typeof XUserSchema>>();
    let paginationToken: string | undefined;
    let pages = 0;
    let reachedCursor = false;

    // dm_events does not take since_id on every tier, so page back (newest first) until a page
    // reaches the cursor, then filter client-side.
    do {
      const params = new URLSearchParams({
        max_results: String(POLL_PAGE_SIZE),
        event_types: "MessageCreate",
        expansions: "sender_id",
        "dm_event.fields": "id,text,event_type,sender_id,dm_conversation_id,created_at",
        "user.fields": "username,name",
      });
      if (paginationToken) params.set("pagination_token", paginationToken);

      const response = await this.retriever.fetchValidatedJson({
        url: `/2/dm_events?${params}`,
        opts: { method: "GET" },
        schema: XDmEventsResponseSchema,
        context: "X poll DMs",
      });
      if (this.isStopped()) return;

      for (const event of response.data) {
        if (this.sinceDmEventId && !isSnowflakeAfter(event.id, this.sinceDmEventId)) {
          reachedCursor = true;
          continue;
        }
        events.set(event.id, event);
      }
      for (const user of response.includes?.users ?? []) users.set(user.id, user);
      paginationToken = this.sinceDmEventId && !reachedCursor ? response.meta?.next_token : undefined;
      pages++;
    } while (paginationToken && pages < MAX_POLL_PAGES);

    if (paginationToken) {
      this.app.serviceError(this.service, `More than ${MAX_POLL_PAGES * POLL_PAGE_SIZE} new X DM events arrived since the last poll; the oldest were skipped`);
    }

    const ordered = [...events.values()].sort((a, b) => compareSnowflakes(a.id, b.id));
    for (const event of ordered) {
      if (this.isStopped()) return;
      if (event.event_type === "MessageCreate" && event.sender_id && event.sender_id !== this.userId && event.dm_conversation_id) {
        const sender = users.get(event.sender_id);
        await this.emit({
          conversationId: `${DM_PREFIX}${event.dm_conversation_id}`,
          userId: event.sender_id,
          userName: sender ? displayName(sender) : event.sender_id,
          text: event.text ?? "",
          messageId: event.id,
          hasAttachments: false,
          direct: true,
          addressed: true,
        });
      }
      this.sinceDmEventId = event.id;
      this.saveState();
    }
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

function compareSnowflakes(a: string, b: string): number {
  if (a === b) return 0;
  return isSnowflakeAfter(a, b) ? 1 : -1;
}

/** Snowflake ids are chronological when compared as big integers (or long digit strings). */
function isSnowflakeAfter(id: string, since: string): boolean {
  if (id === since) return false;
  if (id.length !== since.length) return id.length > since.length;
  return id > since;
}

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Agent from "@tokenring-ai/agent/Agent";
import type TokenRingApp from "@tokenring-ai/app";
import createTestingApp from "@tokenring-ai/app/test/createTestingApp.test";
import { BotService, type IncomingMessage } from "@tokenring-ai/bot";
import ChatService, { type CheckToolApprovalOptions } from "@tokenring-ai/chat/ChatService";
import { doFetchWithRetry } from "../../utility/http/doFetchWithRetry.ts";
import ProviderStateFile from "../ProviderStateFile.ts";
import plugin from "../plugin.ts";
import { type ResolvedXAccountConfig, XAccountConfigSchema } from "../schema.ts";
import createPostTool from "../tools/createPost.ts";
import XMessagingProvider, { XCursorStateSchema } from "../XMessagingProvider.ts";
import XService from "../XService.ts";

void mock.module("../../utility/http/doFetchWithRetry.ts", () => ({
  doFetchWithRetry: mock(),
}));

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response;
}

function fetchCall(index: number) {
  const call = (doFetchWithRetry as ReturnType<typeof mock>).mock.calls[index]!;
  return { url: String(call[0]), opts: call[1] as Record<string, unknown> };
}

function lastFetchCall() {
  const calls = (doFetchWithRetry as ReturnType<typeof mock>).mock.calls;
  return fetchCall(calls.length - 1);
}

function mockApp(): TokenRingApp {
  return {
    serviceOutput: mock(),
    serviceError: mock(),
  } as unknown as TokenRingApp;
}

function mockService(): XService {
  return { name: "XService" } as unknown as XService;
}

function parsedAccount(overrides: Partial<ResolvedXAccountConfig> = {}): ResolvedXAccountConfig {
  const base = XAccountConfigSchema.parse({ accessToken: "secret-token" });
  return { ...base, accessToken: "secret-token", ...overrides };
}

async function startProvider(account = parsedAccount()) {
  const provider = new XMessagingProvider(mockApp(), mockService(), "x", account);
  const fetch = doFetchWithRetry as ReturnType<typeof mock>;

  fetch.mockResolvedValueOnce(
    jsonResponse({
      data: { id: "99", username: "tokenring", name: "Token Ring" },
    }),
  );
  // seedCursors only hits endpoints that are enabled on the account.
  if (account.pollMentions) {
    fetch.mockResolvedValueOnce(jsonResponse({ data: [], meta: {} }));
  }
  if (account.pollDirectMessages) {
    fetch.mockResolvedValueOnce(jsonResponse({ data: [], meta: {} }));
  }

  await provider.start();
  return provider;
}

describe("XMessagingProvider", () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  it("connects by looking up /2/users/me", async () => {
    const provider = await startProvider();
    expect(fetchCall(0).url).toContain("/2/users/me");
    expect(fetchCall(0).opts).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
        }),
      }),
    );
    await provider.stop();
  });

  it("resolves a bare user id as a DM-with conversation", async () => {
    const provider = await startProvider();
    expect(provider.resolveConversation("12345")).toBe("dm:with:12345");
    expect(provider.resolveConversation("dm:99-12345")).toBe("dm:99-12345");
    expect(provider.resolveConversation("tweet:111")).toBe("tweet:111");
    await provider.stop();
  });

  it("holds working placeholders without calling the API", async () => {
    const provider = await startProvider();
    const callsBefore = (doFetchWithRetry as ReturnType<typeof mock>).mock.calls.length;

    const id = await provider.sendMessage("tweet:1", "***Thinking... ⏳***");
    expect(id.startsWith("pending:")).toBe(true);
    expect((doFetchWithRetry as ReturnType<typeof mock>).mock.calls.length).toBe(callsBefore);

    (doFetchWithRetry as ReturnType<typeof mock>).mockResolvedValueOnce(jsonResponse({ data: { id: "tweet-9", text: "hello from the bot" } }));

    const realId = await provider.updateMessage("tweet:1", id, "hello from the bot");
    expect(realId).toBe("tweet-9");
    expect(lastFetchCall().url).toContain("/2/tweets");
    expect(lastFetchCall().opts).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "hello from the bot", reply: { in_reply_to_tweet_id: "1" } }),
      }),
    );
    await provider.stop();
  });

  it("posts a DM to a user via the with-participant endpoint", async () => {
    const provider = await startProvider();
    (doFetchWithRetry as ReturnType<typeof mock>).mockResolvedValueOnce(jsonResponse({ data: { dm_event_id: "dm-1", dm_conversation_id: "99-55" } }));

    const id = await provider.sendMessage("dm:with:55", "private hello");
    expect(id).toBe("dm-1");
    expect(lastFetchCall().url).toContain("/2/dm_conversations/with/55/messages");
    await provider.stop();
  });

  it("delivers polled mentions as addressed channel traffic, answered under the mention itself", async () => {
    const provider = await startProvider({ ...parsedAccount(), pollDirectMessages: false });
    const received: IncomingMessage[] = [];
    provider.onMessage(message => {
      received.push(message);
    });

    (doFetchWithRetry as ReturnType<typeof mock>).mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "t-2",
            text: "@tokenring please help",
            author_id: "55",
            conversation_id: "t-1",
            referenced_tweets: [{ type: "replied_to", id: "t-1" }],
          },
        ],
        includes: {
          users: [{ id: "55", username: "alice", name: "Alice" }],
        },
        meta: { newest_id: "t-2", result_count: 1 },
      }),
    );

    // Access private poll via casting — exercises the same path as the interval.
    await (provider as unknown as { poll(): Promise<void> }).poll();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(
      expect.objectContaining({
        conversationId: "tweet:t-1",
        userId: "55",
        userName: "Alice (@alice)",
        roomId: "mentions",
        text: "please help",
        messageId: "t-2",
        // The parent is t-1 (someone else's post); the answer goes under the mention itself.
        replyToMessageId: "t-1",
        replyTarget: "t-2",
        direct: false,
        addressed: true,
      }),
    );
    await provider.stop();
  });

  it("delivers polled DMs to handlers", async () => {
    const provider = await startProvider({ ...parsedAccount(), pollMentions: false });
    const received: IncomingMessage[] = [];
    provider.onMessage(message => {
      received.push(message);
    });

    (doFetchWithRetry as ReturnType<typeof mock>).mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "e-9",
            event_type: "MessageCreate",
            text: "hi bot",
            sender_id: "55",
            dm_conversation_id: "99-55",
          },
        ],
        includes: {
          users: [{ id: "55", username: "alice", name: "Alice" }],
        },
        meta: { newest_id: "e-9", result_count: 1 },
      }),
    );

    await (provider as unknown as { poll(): Promise<void> }).poll();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(
      expect.objectContaining({
        conversationId: "dm:99-55",
        userId: "55",
        text: "hi bot",
        direct: true,
        addressed: true,
      }),
    );
    await provider.stop();
  });

  it("creates a standalone post without a reply target", async () => {
    const provider = await startProvider();
    (doFetchWithRetry as ReturnType<typeof mock>).mockResolvedValueOnce(jsonResponse({ data: { id: "tweet-1", text: "hello" } }));

    const id = await provider.createPost("  hello  ");
    expect(id).toBe("tweet-1");
    expect(lastFetchCall().url).toContain("/2/tweets");
    expect(lastFetchCall().opts).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "hello" }),
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      }),
    );
    await provider.stop();
  });

  it("creates a post as a reply when a tweet id is given", async () => {
    const provider = await startProvider();
    (doFetchWithRetry as ReturnType<typeof mock>).mockResolvedValueOnce(jsonResponse({ data: { id: "tweet-2", text: "reply" } }));

    const id = await provider.createPost("reply", "42");
    expect(id).toBe("tweet-2");
    expect(lastFetchCall().opts).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "reply", reply: { in_reply_to_tweet_id: "42" } }),
      }),
    );
    await provider.stop();
  });

  it("does not call the API for an empty or too-long post", async () => {
    const provider = await startProvider();
    const calls = (doFetchWithRetry as ReturnType<typeof mock>).mock.calls.length;

    await expect(provider.createPost("  ")).rejects.toThrow(/text is required/);
    await expect(provider.createPost("x".repeat(provider.maxMessageLength + 1))).rejects.toThrow(/longer than this account's limit/);
    expect((doFetchWithRetry as ReturnType<typeof mock>).mock.calls.length).toBe(calls);
    await provider.stop();
  });
});

function mentionsPage(tweets: Array<{ id: string; text?: string; author_id?: string; replied_to?: string }>, nextToken?: string) {
  return jsonResponse({
    data: tweets.map(tweet => ({
      id: tweet.id,
      text: tweet.text ?? "@tokenring hi",
      author_id: tweet.author_id ?? "55",
      conversation_id: "c-1",
      ...(tweet.replied_to ? { referenced_tweets: [{ type: "replied_to", id: tweet.replied_to }] } : {}),
    })),
    includes: { users: [{ id: "55", username: "alice" }] },
    meta: { result_count: tweets.length, ...(nextToken ? { next_token: nextToken } : {}) },
  });
}

function poll(provider: XMessagingProvider) {
  return (provider as unknown as { poll(): Promise<void> }).poll();
}

function mentionsOnly() {
  return parsedAccount({ pollDirectMessages: false });
}

describe("XMessagingProvider polling", () => {
  let dir: string;

  beforeEach(() => {
    mock.clearAllMocks();
    (doFetchWithRetry as ReturnType<typeof mock>).mockReset();
    dir = mkdtempSync(path.join(tmpdir(), "x-cursors-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stateFile() {
    return new ProviderStateFile(path.join(dir, "x.json"), XCursorStateSchema);
  }

  async function start(account: ResolvedXAccountConfig, file = stateFile(), seed?: Response | Error) {
    const fetch = doFetchWithRetry as ReturnType<typeof mock>;
    fetch.mockResolvedValueOnce(jsonResponse({ data: { id: "99", username: "tokenring" } }));
    if (seed instanceof Error) fetch.mockRejectedValueOnce(seed);
    else if (seed) fetch.mockResolvedValueOnce(seed);
    const provider = new XMessagingProvider(mockApp(), mockService(), "x", account, file);
    await provider.start();
    return provider;
  }

  it("answers a reply to one of our own posts under that post, so outreach threads still match", async () => {
    const provider = await start(mentionsOnly(), stateFile(), jsonResponse({ data: [], meta: {} }));
    const fetch = doFetchWithRetry as ReturnType<typeof mock>;
    fetch.mockResolvedValueOnce(jsonResponse({ data: { id: "500" } }));
    await provider.sendMessage("tweet:c-1", "question for you");

    const received: IncomingMessage[] = [];
    provider.onMessage(message => {
      received.push(message);
    });
    fetch.mockResolvedValueOnce(mentionsPage([{ id: "501", text: "the answer", replied_to: "500" }]));
    await poll(provider);

    expect(received[0]).toEqual(expect.objectContaining({ messageId: "501", replyToMessageId: "500", addressed: true, direct: false }));
    await provider.stop();
  });

  it("does not deliver anything until the mentions cursor is seeded, retrying a failed seed", async () => {
    const provider = await start(mentionsOnly(), stateFile(), new Error("seed down"));
    const received: IncomingMessage[] = [];
    provider.onMessage(message => {
      received.push(message);
    });
    const fetch = doFetchWithRetry as ReturnType<typeof mock>;

    // The next poll seeds instead of delivering the newest page of old mentions.
    fetch.mockResolvedValueOnce(mentionsPage([{ id: "300" }, { id: "200" }]));
    await poll(provider);
    expect(received).toHaveLength(0);
    expect(fetchCall(fetch.mock.calls.length - 1).url).toContain("max_results=5");

    fetch.mockResolvedValueOnce(mentionsPage([{ id: "301" }]));
    await poll(provider);
    expect(fetchCall(fetch.mock.calls.length - 1).url).toContain("since_id=300");
    expect(received.map(message => message.messageId)).toEqual(["301"]);
    await provider.stop();
  });

  it("follows next_token so a burst larger than one page is delivered whole, oldest first", async () => {
    const file = stateFile();
    const provider = await start(mentionsOnly(), file, mentionsPage([{ id: "100" }]));
    const received: IncomingMessage[] = [];
    provider.onMessage(message => {
      received.push(message);
    });
    const fetch = doFetchWithRetry as ReturnType<typeof mock>;
    fetch.mockResolvedValueOnce(mentionsPage([{ id: "104" }, { id: "103" }], "page-2")).mockResolvedValueOnce(mentionsPage([{ id: "102" }, { id: "101" }]));

    await poll(provider);
    expect(fetchCall(fetch.mock.calls.length - 1).url).toContain("pagination_token=page-2");
    expect(received.map(message => message.messageId)).toEqual(["101", "102", "103", "104"]);
    expect(file.load()?.sinceMentionId).toBe("104");
    await provider.stop();
  });

  it("stops mid-poll without delivering the rest or moving the cursor past them", async () => {
    const file = stateFile();
    const provider = await start(mentionsOnly(), file, mentionsPage([{ id: "100" }]));
    const received: IncomingMessage[] = [];
    provider.onMessage(async message => {
      received.push(message);
      await provider.stop();
    });
    (doFetchWithRetry as ReturnType<typeof mock>).mockResolvedValueOnce(mentionsPage([{ id: "103" }, { id: "102" }, { id: "101" }]));

    await poll(provider);
    expect(received.map(message => message.messageId)).toEqual(["101"]);
    expect(file.load()?.sinceMentionId).toBe("101");
  });

  it("resumes from the saved cursors after a restart instead of reseeding", async () => {
    const file = stateFile();
    const first = await start(mentionsOnly(), file, mentionsPage([{ id: "100" }]));
    await first.stop();

    // No seed request this time: the saved cursor is used, so downtime mentions are delivered.
    const second = await start(mentionsOnly(), file);
    const received: IncomingMessage[] = [];
    second.onMessage(message => {
      received.push(message);
    });
    const fetch = doFetchWithRetry as ReturnType<typeof mock>;
    fetch.mockResolvedValueOnce(mentionsPage([{ id: "150" }]));
    await poll(second);

    expect(fetchCall(fetch.mock.calls.length - 1).url).toContain("since_id=100");
    expect(received.map(message => message.messageId)).toEqual(["150"]);
    await second.stop();
  });

  it("pages DM events back to the cursor and advances it per event", async () => {
    const file = stateFile();
    const dmPage = (ids: string[], nextToken?: string) =>
      jsonResponse({
        data: ids.map(id => ({ id, event_type: "MessageCreate", text: `dm ${id}`, sender_id: "55", dm_conversation_id: "55-99" })),
        meta: nextToken ? { next_token: nextToken } : {},
      });
    const provider = await start(parsedAccount({ pollMentions: false }), file, dmPage(["100"]));
    const received: IncomingMessage[] = [];
    provider.onMessage(message => {
      received.push(message);
    });
    (doFetchWithRetry as ReturnType<typeof mock>)
      .mockResolvedValueOnce(dmPage(["103", "102"], "older"))
      .mockResolvedValueOnce(dmPage(["101", "100", "99"], "even-older"));

    await poll(provider);
    expect(received.map(message => message.messageId)).toEqual(["101", "102", "103"]);
    expect(file.load()?.sinceDmEventId).toBe("103");
    await provider.stop();
  });

  it("sends posts and DMs without retrying server errors", async () => {
    const provider = await start(mentionsOnly(), stateFile(), jsonResponse({ data: [], meta: {} }));
    const fetch = doFetchWithRetry as ReturnType<typeof mock>;
    fetch.mockResolvedValueOnce(jsonResponse({ data: { id: "1" } })).mockResolvedValueOnce(jsonResponse({ data: { dm_event_id: "2" } }));
    await provider.sendMessage("tweet:c-1", "public");
    expect(fetch.mock.calls.at(-1)?.[2]).toEqual({ idempotent: false });
    await provider.sendMessage("dm:with:55", "private");
    expect(fetch.mock.calls.at(-1)?.[2]).toEqual({ idempotent: false });
    await provider.stop();
  });
});

describe("X createPost", () => {
  let x: XService | undefined;

  afterEach(async () => {
    await x?.stop();
    x = undefined;
    // Drop the URL-routed fetch stub so it cannot leak into other test files.
    fetchMock().mockReset();
  });

  function fetchMock() {
    return doFetchWithRetry as ReturnType<typeof mock>;
  }

  function tweetPosts() {
    return fetchMock().mock.calls.filter(call => String(call[0]).includes("/2/tweets") && (call[1] as { method?: string } | undefined)?.method === "POST");
  }

  function agentFor(service: XService, approve: boolean) {
    const checkToolApproval = mock<(request: CheckToolApprovalOptions, agent: Agent) => Promise<boolean>>(async () => approve);
    const services = new Map<unknown, unknown>([
      [XService, service],
      [ChatService, { checkToolApproval }],
    ]);
    const agent = {
      infoMessage: mock(),
      requireService: (cls: unknown) => {
        const serviceImpl = services.get(cls);
        if (!serviceImpl) throw new Error("service not stubbed");
        return serviceImpl;
      },
    } as unknown as Agent;
    return { agent, checkToolApproval };
  }

  async function connect(accounts: Record<string, ResolvedXAccountConfig> = { x: parsedAccount() }) {
    const app = createTestingApp();
    app.addService(BotService, {
      registerProvider() {},
      unregisterProvider() {},
    } as unknown as BotService);

    fetchMock().mockReset();
    fetchMock().mockImplementation(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/2/users/me")) return jsonResponse({ data: { id: "99", username: "tokenring", name: "Token Ring" } });
      if (href.includes("/mentions") || href.includes("/2/dm_events")) return jsonResponse({ data: [], meta: {} });
      if (href.includes("/2/tweets")) return jsonResponse({ data: { id: "tweet-1", text: "hello" } });
      throw new Error(`unexpected X request ${href}`);
    });

    x = new XService(app);
    await x.reconfigure({ accounts });
    return x;
  }

  it("rejects empty text before any request", async () => {
    fetchMock().mockReset();
    const service = new XService(createTestingApp());
    await expect(service.createPost("  ")).rejects.toThrow(/text is required/);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("posts through the named account's existing client", async () => {
    const service = await connect();
    const post = await service.createPost("hello there", { replyToTweetId: "42" });
    expect(post).toEqual({ id: "tweet-1", account: "x" });
    expect(tweetPosts()).toHaveLength(1);
    expect(tweetPosts()[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "hello there", reply: { in_reply_to_tweet_id: "42" } }),
        headers: expect.objectContaining({ Authorization: "Bearer secret-token" }),
      }),
    );
  });

  it("x_createPost posts only after approval", async () => {
    const service = await connect();
    const { agent, checkToolApproval } = agentFor(service, true);
    const result = await createPostTool.execute({ text: "hello there" }, agent);

    expect(checkToolApproval).toHaveBeenCalledTimes(1);
    expect(checkToolApproval.mock.calls[0]?.[0]).toMatchObject({
      toolName: "x_createPost",
      default: false,
      safetyLevel: 8,
    });
    expect(String(checkToolApproval.mock.calls[0]![0].detailedDescription)).toContain("hello there");
    expect(result.result).toContain("tweet-1");
    expect(tweetPosts()).toHaveLength(1);
    expect(tweetPosts()[0]?.[1]).toEqual(expect.objectContaining({ body: JSON.stringify({ text: "hello there" }) }));
  });

  it("declined approval does not post", async () => {
    const service = await connect();
    const { agent, checkToolApproval } = agentFor(service, false);

    await expect(createPostTool.execute({ text: "hello there", replyToTweetId: "42" }, agent)).rejects.toThrow(/did not approve/);
    expect(checkToolApproval).toHaveBeenCalledTimes(1);
    expect(tweetPosts()).toHaveLength(0);
  });

  it("does not ask for approval or post when the text is empty or too long", async () => {
    const service = await connect();
    const { agent, checkToolApproval } = agentFor(service, true);

    await expect(createPostTool.execute({ text: "  " }, agent)).rejects.toThrow(/text is required/);
    await expect(createPostTool.execute({ text: "x".repeat(281) }, agent)).rejects.toThrow(/longer than the x account limit of 280/);
    expect(checkToolApproval).not.toHaveBeenCalled();
    expect(tweetPosts()).toHaveLength(0);
  });

  it("requires an account name when more than one is connected", async () => {
    const service = await connect({ primary: parsedAccount(), support: parsedAccount() });
    const { agent, checkToolApproval } = agentFor(service, true);

    await expect(createPostTool.execute({ text: "hello" }, agent)).rejects.toThrow(/Multiple X accounts/);
    expect(checkToolApproval).not.toHaveBeenCalled();
    expect(tweetPosts()).toHaveLength(0);

    const result = await createPostTool.execute({ text: "hello", account: "support", replyToTweetId: "42" }, agent);
    expect(result.result).toContain("as support");
    expect(tweetPosts()).toHaveLength(1);
  });

  it("registers x_createPost and x_schedulePost with chat", () => {
    const addTools = mock((tools: { name: string }[]) => tools);
    const app = {
      addService: mock(),
      waitForService: (_type: unknown, callback: (service: unknown) => void) => {
        callback({ addTools, addAgentCommands: mock(), registerEndpoint: mock() });
      },
    };
    plugin.install(app as unknown as TokenRingApp);
    expect(addTools).toHaveBeenCalledTimes(1);
    expect(addTools.mock.calls[0]![0].map(tool => tool.name)).toEqual(["x_createPost", "x_schedulePost"]);
  });
});

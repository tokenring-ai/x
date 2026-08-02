import { beforeEach, describe, expect, it, mock } from "bun:test";
import type TokenRingApp from "@tokenring-ai/app";
import type { IncomingMessage } from "@tokenring-ai/bot";
import { doFetchWithRetry } from "../../utility/http/doFetchWithRetry.ts";
import { type ResolvedXAccountConfig, XAccountConfigSchema } from "../schema.ts";
import XMessagingProvider from "../XMessagingProvider.ts";
import type XService from "../XService.ts";

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

  it("delivers polled mentions to handlers as direct, addressed messages", async () => {
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
        text: "please help",
        messageId: "t-2",
        direct: true,
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
});

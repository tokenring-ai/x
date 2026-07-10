import { beforeEach, describe, expect, it, mock } from "bun:test";
import { doFetchWithRetry } from "../../utility/http/doFetchWithRetry.ts";
import { XProviderOptionsSchema } from "../schema";
import XSocialMediaProvider from "../XSocialMediaProvider.ts";

void mock.module("../../utility/http/doFetchWithRetry.ts", () => ({
  doFetchWithRetry: mock(),
}));

const mockAgent = {} as any;

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

describe("XSocialMediaProvider", () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  it("retrieves the authenticated account from /2/users/me", async () => {
    (doFetchWithRetry as ReturnType<typeof mock>).mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "123",
          username: "tokenring",
          name: "Token Ring",
          description: "AI tooling",
          profile_image_url: "https://example.com/avatar.png",
        },
      }),
    );

    const provider = new XSocialMediaProvider(
      XProviderOptionsSchema.parse({
        bearerToken: "secret",
      }),
    );

    const account = await provider.getAccount(mockAgent);

    expect(account.username).toBe("tokenring");
    expect(account.url).toBe("https://x.com/tokenring");
    const { url, opts } = lastFetchCall();
    expect(url).toContain("/2/users/me");
    expect(opts).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
        }),
      }),
    );
  });

  it("lists recent posts for the authenticated account", async () => {
    (doFetchWithRetry as ReturnType<typeof mock>)
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: "123",
            username: "tokenring",
            name: "Token Ring",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "tweet-1",
              text: "hello from x",
              created_at: "2025-01-01T00:00:00.000Z",
              public_metrics: {
                like_count: 2,
                reply_count: 3,
                retweet_count: 4,
                quote_count: 5,
              },
            },
          ],
        }),
      );

    const provider = new XSocialMediaProvider(
      XProviderOptionsSchema.parse({
        bearerToken: "secret",
      }),
    );

    const posts = await provider.getRecentPosts(
      {
        limit: 5,
        includeReplies: false,
        includeReshares: false,
      },
      mockAgent,
    );

    expect(posts).toHaveLength(1);
    expect(posts[0]!.id).toBe("tweet-1");
    expect(posts[0]!.author.username).toBe("tokenring");
    expect(posts[0]!.metrics?.shares).toBe(4);
    expect(lastFetchCall().url).toContain("exclude=replies%2Cretweets");
  });

  it("creates a post and reloads it", async () => {
    (doFetchWithRetry as ReturnType<typeof mock>)
      .mockResolvedValueOnce(
        jsonResponse({
          data: { id: "tweet-9", text: "new post" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: "tweet-9",
            text: "new post",
            created_at: "2025-01-01T00:00:00.000Z",
          },
          includes: {
            users: [
              {
                id: "123",
                username: "tokenring",
                name: "Token Ring",
              },
            ],
          },
        }),
      );

    const provider = new XSocialMediaProvider(
      XProviderOptionsSchema.parse({
        bearerToken: "secret",
      }),
    );

    const post = await provider.createPost({ content: "new post" }, mockAgent);

    expect(post.id).toBe("tweet-9");
    expect(post.content).toBe("new post");
    const { url, opts } = fetchCall(0);
    expect(url).toContain("/2/tweets");
    expect(opts).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "new post" }),
      }),
    );
  });
});

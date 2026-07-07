import type { Agent } from "@tokenring-ai/agent";
import { HTTPRetriever } from "@tokenring-ai/utility/http/HTTPRetriever";
import { stripUndefinedKeys } from "@tokenring-ai/utility/object/stripObject";
import { z } from "zod";
import type { CreateSocialMediaPostData, SocialMediaAccount, SocialMediaPost, SocialMediaPostFilterOptions, SocialMediaProvider } from "../social/index.ts";
import type { XProviderOptionsSchema } from "./schema.ts";

type XUser = {
  id: string;
  username: string;
  name?: string | undefined;
  description?: string | undefined;
  profile_image_url?: string | undefined;
};

/*type XTweet = {
  id: string;
  text: string;
  created_at?: string | undefined;
  conversation_id?: string | undefined;
  public_metrics?: {
    like_count?: number | undefined;
    reply_count?: number | undefined;
    retweet_count?: number | undefined;
    quote_count?: number | undefined;
    impression_count?: number | undefined;
  };
};*/

const XUserSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    profile_image_url: z.string().optional(),
  })
  .loose();

const XTweetSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    created_at: z.string().optional(),
    conversation_id: z.string().optional(),
    public_metrics: z
      .object({
        like_count: z.number().optional(),
        reply_count: z.number().optional(),
        retweet_count: z.number().optional(),
        quote_count: z.number().optional(),
        impression_count: z.number().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const XRecentPostsResponseSchema = z
  .object({
    data: z.array(XTweetSchema).default([]),
  })
  .loose();

const XPostLookupResponseSchema = z
  .object({
    data: XTweetSchema,
    includes: z
      .object({
        users: z.array(XUserSchema).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const XCreatePostResponseSchema = z
  .object({
    data: z
      .object({
        id: z.string(),
      })
      .loose(),
  })
  .loose();

const XAccountResponseSchema = z
  .object({
    data: XUserSchema,
  })
  .loose();

export default class XSocialMediaProvider implements SocialMediaProvider {
  description = "Authenticated X/Twitter social media provider";

  private readonly retriever: HTTPRetriever;
  private accountPromise?: Promise<SocialMediaAccount>;

  constructor(private readonly options: z.output<typeof XProviderOptionsSchema>) {
    this.retriever = new HTTPRetriever({
      baseUrl: options.baseUrl,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": options.userAgent,
        Authorization: `Bearer ${options.bearerToken}`,
      },
      timeout: 10_000,
    });
  }

  async getAccount(_agent: Agent): Promise<SocialMediaAccount> {
    if (!this.accountPromise) {
      this.accountPromise = this.fetchAccount();
    }
    return await this.accountPromise;
  }

  async getRecentPosts(filter: SocialMediaPostFilterOptions, agent: Agent): Promise<SocialMediaPost[]> {
    const account = await this.getAccount(agent);
    const params = new URLSearchParams({
      max_results: String(Math.min(filter.limit ?? 10, 100)),
      "tweet.fields": "created_at,public_metrics,conversation_id",
    });

    const exclude: string[] = [];
    if (filter.includeReplies === false) exclude.push("replies");
    if (filter.includeReshares === false) exclude.push("retweets");
    if (exclude.length) params.set("exclude", exclude.join(","));
    if (filter.since) params.set("start_time", filter.since.toISOString());
    if (filter.until) params.set("end_time", filter.until.toISOString());

    const response = await this.retriever.fetchValidatedJson({
      url: `/2/users/${account.id}/tweets?${params.toString()}`,
      opts: { method: "GET" },
      schema: XRecentPostsResponseSchema,
      context: "X recent posts",
    });

    return response.data.map(tweet => this.mapTweetToPost(tweet, account));
  }

  async getPostById(id: string, agent: Agent): Promise<SocialMediaPost> {
    if (!id) throw new Error("id is required");

    const params = new URLSearchParams({
      "tweet.fields": "created_at,public_metrics,conversation_id",
      expansions: "author_id",
      "user.fields": "username,name,description,profile_image_url",
    });

    const response = await this.retriever.fetchValidatedJson({
      url: `/2/tweets/${id}?${params.toString()}`,
      opts: { method: "GET" },
      schema: XPostLookupResponseSchema,
      context: "X post lookup",
    });

    const includedUser = response.includes?.users?.[0] as XUser | undefined;
    const account = includedUser ? this.mapUserToAccount(includedUser) : await this.getAccount(agent);
    return this.mapTweetToPost(response.data, account);
  }

  async createPost(data: CreateSocialMediaPostData, agent: Agent): Promise<SocialMediaPost> {
    if (!data.content.trim()) throw new Error("content is required");

    const payload: Record<string, unknown> = {
      text: data.content,
    };

    if (data.replyToPostId) {
      payload.reply = { in_reply_to_tweet_id: data.replyToPostId };
    }

    const response = await this.retriever.fetchValidatedJson({
      url: "/2/tweets",
      opts: {
        method: "POST",
        body: JSON.stringify(payload),
      },
      schema: XCreatePostResponseSchema,
      context: "X create post",
    });

    return await this.getPostById(response.data.id, agent);
  }

  private async fetchAccount(): Promise<SocialMediaAccount> {
    const response = this.options.userId
      ? await this.retriever.fetchValidatedJson({
          url: `/2/users/${this.options.userId}?user.fields=username,name,description,profile_image_url`,
          opts: { method: "GET" },
          schema: XAccountResponseSchema,
          context: "X account lookup",
        })
      : await this.retriever.fetchValidatedJson({
          url: "/2/users/me?user.fields=username,name,description,profile_image_url",
          opts: { method: "GET" },
          schema: XAccountResponseSchema,
          context: "X current account lookup",
        });

    return this.mapUserToAccount(response.data);
  }

  private mapUserToAccount(user: z.output<typeof XUserSchema>): SocialMediaAccount {
    return stripUndefinedKeys({
      id: user.id,
      username: user.username,
      displayName: user.name,
      description: user.description,
      avatarUrl: user.profile_image_url,
      url: `https://x.com/${user.username}`,
    });
  }

  private mapTweetToPost(tweet: z.output<typeof XTweetSchema>, account: SocialMediaAccount): SocialMediaPost {
    const createdAt = tweet.created_at ? new Date(tweet.created_at) : new Date();

    return {
      id: tweet.id,
      platform: "x",
      content: tweet.text,
      status: "published",
      url: `https://x.com/${account.username}/status/${tweet.id}`,
      author: stripUndefinedKeys({
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        url: account.url,
        avatarUrl: account.avatarUrl,
      }),
      createdAt,
      publishedAt: createdAt,
      ...(tweet.conversation_id &&
        tweet.conversation_id !== tweet.id && {
          replyToPostId: tweet.conversation_id,
        }),
      metrics: stripUndefinedKeys({
        likes: tweet.public_metrics?.like_count,
        comments: tweet.public_metrics?.reply_count,
        shares: tweet.public_metrics?.retweet_count,
        quotes: tweet.public_metrics?.quote_count,
        impressions: tweet.public_metrics?.impression_count,
      }),
      metadata: {
        conversationId: tweet.conversation_id,
      },
    };
  }
}

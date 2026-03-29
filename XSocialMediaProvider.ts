import {Agent} from "@tokenring-ai/agent";
import {HttpService} from "../utility/http/HttpService.ts";
import {z} from "zod";
import type {
  CreateSocialMediaPostData,
  SocialMediaAccount,
  SocialMediaPost,
  SocialMediaPostFilterOptions,
  SocialMediaProvider,
} from "../social/index.ts";

export const XProviderOptionsSchema = z.object({
  type: z.literal("x").default("x"),
  baseUrl: z.string().default("https://api.x.com"),
  bearerToken: z.string(),
  userAgent: z.string().default("TokenRing-Writer/1.0 (https://github.com/tokenring/writer)"),
  userId: z.string().optional(),
});

type XUser = {
  id: string;
  username: string;
  name?: string;
  description?: string;
  profile_image_url?: string;
};

type XTweet = {
  id: string;
  text: string;
  created_at?: string;
  conversation_id?: string;
  public_metrics?: {
    like_count?: number;
    reply_count?: number;
    retweet_count?: number;
    quote_count?: number;
    impression_count?: number;
  };
};

export default class XSocialMediaProvider extends HttpService implements SocialMediaProvider {
  description = "Authenticated X/Twitter social media provider";

  protected baseUrl: string;
  protected defaultHeaders: Record<string, string>;

  private accountPromise?: Promise<SocialMediaAccount>;

  constructor(private readonly options: z.output<typeof XProviderOptionsSchema>) {
    super();
    this.baseUrl = options.baseUrl;
    this.defaultHeaders = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": options.userAgent,
      Authorization: `Bearer ${options.bearerToken}`,
    };
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

    const response = await this.fetchJson(
      `/2/users/${account.id}/tweets?${params.toString()}`,
      {method: "GET"},
      "X recent posts",
    );

    return (response.data ?? []).map((tweet: XTweet) => this.mapTweetToPost(tweet, account));
  }

  async getPostById(id: string, agent: Agent): Promise<SocialMediaPost> {
    if (!id) throw new Error("id is required");

    const params = new URLSearchParams({
      "tweet.fields": "created_at,public_metrics,conversation_id",
      expansions: "author_id",
      "user.fields": "username,name,description,profile_image_url",
    });

    const response = await this.fetchJson(
      `/2/tweets/${id}?${params.toString()}`,
      {method: "GET"},
      "X post lookup",
    );

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
      payload.reply = {in_reply_to_tweet_id: data.replyToPostId};
    }

    const response = await this.fetchJson(
      "/2/tweets",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      "X create post",
    );

    return await this.getPostById(response.data.id, agent);
  }

  private async fetchAccount(): Promise<SocialMediaAccount> {
    const response = this.options.userId
      ? await this.fetchJson(
        `/2/users/${this.options.userId}?user.fields=username,name,description,profile_image_url`,
        {method: "GET"},
        "X account lookup",
      )
      : await this.fetchJson(
        "/2/users/me?user.fields=username,name,description,profile_image_url",
        {method: "GET"},
        "X current account lookup",
      );

    return this.mapUserToAccount(response.data);
  }

  private mapUserToAccount(user: XUser): SocialMediaAccount {
    return {
      id: user.id,
      username: user.username,
      displayName: user.name,
      description: user.description,
      avatarUrl: user.profile_image_url,
      url: `https://x.com/${user.username}`,
    };
  }

  private mapTweetToPost(tweet: XTweet, account: SocialMediaAccount): SocialMediaPost {
    const createdAt = tweet.created_at ? new Date(tweet.created_at) : new Date();
    return {
      id: tweet.id,
      platform: "x",
      content: tweet.text ?? "",
      status: "published",
      url: `https://x.com/${account.username}/status/${tweet.id}`,
      author: {
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        url: account.url,
        avatarUrl: account.avatarUrl,
      },
      createdAt,
      publishedAt: createdAt,
      replyToPostId: tweet.conversation_id && tweet.conversation_id !== tweet.id ? tweet.conversation_id : undefined,
      metrics: {
        likes: tweet.public_metrics?.like_count,
        comments: tweet.public_metrics?.reply_count,
        shares: tweet.public_metrics?.retweet_count,
        quotes: tweet.public_metrics?.quote_count,
        impressions: tweet.public_metrics?.impression_count,
      },
      metadata: {
        conversationId: tweet.conversation_id,
      },
    };
  }
}

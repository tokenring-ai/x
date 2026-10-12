import type TokenRingApp from "@tokenring-ai/app";
import { ConfigurationError, type TokenRingService } from "@tokenring-ai/app/types";
import { BotService } from "@tokenring-ai/bot";
import KeyedRegistry from "@tokenring-ai/utility/registry/KeyedRegistry";
import { deepEquals } from "bun";
import type { ResolvedXServiceConfig } from "./schema.ts";
import XMessagingProvider from "./XMessagingProvider.ts";

export type XCreatedPost = {
  id: string;
  account: string;
};

/**
 * Connects the configured X accounts and registers each one with the bot
 * service, where it becomes the `x`-style prefix of a `service:userId` target.
 * Also publishes standalone posts through those accounts' existing API clients.
 */
export default class XService implements TokenRingService {
  readonly name = "XService";
  description = "Connects X (Twitter) accounts to the bot service and can publish posts.";

  private providers = new KeyedRegistry<XMessagingProvider>();
  private options: ResolvedXServiceConfig = { accounts: {} };

  getAvailableAccounts = this.providers.keysArray;
  getProvider = this.providers.get;

  constructor(private app: TokenRingApp) {}

  async reconfigure(options: ResolvedXServiceConfig): Promise<void> {
    const botService = this.requireBotService();

    // Reconcile the live providers against the *incoming* accounts; `this.options`
    // is the previous snapshot, used below only to spot which ones actually changed.
    await this.providers.reconcileAgainstAsync(options.accounts, {
      creating: async (accountName, accountConfig) => {
        this.app.serviceOutput(this, `Connecting X account ${accountName}`);
        const provider = new XMessagingProvider(this.app, this, accountName, accountConfig);
        await provider.start();
        botService.registerProvider(accountName, provider);
        return provider;
      },
      deleting: async (accountName, provider) => {
        this.app.serviceOutput(this, `Stopping X account ${accountName}`);
        botService.unregisterProvider(accountName);
        await provider.stop();
      },
      updating: async (accountName, provider, accountConfig) => {
        if (deepEquals(this.options.accounts[accountName], accountConfig, true)) return provider;

        this.app.serviceOutput(this, `Reconnecting X account ${accountName}`);
        botService.unregisterProvider(accountName);
        await provider.stop();

        const next = new XMessagingProvider(this.app, this, accountName, accountConfig);
        await next.start();
        botService.registerProvider(accountName, next);
        return next;
      },
    });
    this.options = options;
  }

  /**
   * Picks the connected account a post should come from. A single connected
   * account is used when the caller does not name one.
   */
  resolveAccountName(accountName?: string): string {
    const names = this.providers.keysArray();
    if (accountName) {
      if (!this.providers.get(accountName)) {
        throw new Error(`X account "${accountName}" is not connected. Connected accounts: ${names.join(", ") || "(none)"}`);
      }
      return accountName;
    }
    if (names.length === 1) return names[0]!;
    if (names.length === 0) throw new Error("No X account is connected");
    throw new Error(`Multiple X accounts are connected (${names.join(", ")}). Pass an account name.`);
  }

  /** Publishes a post (or a reply) through the named account's existing API client. */
  async createPost(text: string, options: { account?: string; replyToTweetId?: string } = {}): Promise<XCreatedPost> {
    if (!text.trim()) throw new Error("text is required");
    const account = this.resolveAccountName(options.account);
    const id = await this.providers.require(account).createPost(text, options.replyToTweetId);
    return { id, account };
  }

  async stop(): Promise<void> {
    const botService = this.app.getService(BotService);
    for (const [accountName, provider] of this.providers.entriesArray()) {
      botService?.unregisterProvider(accountName);
      await provider.stop();
      this.providers.unregister(accountName);
    }
  }

  private requireBotService(): BotService {
    const botService = this.app.getService(BotService);
    if (!botService) {
      throw new ConfigurationError(
        this.name,
        "X accounts are configured but the @tokenring-ai/bot plugin is not installed, so there is nothing to connect them to",
      );
    }
    return botService;
  }
}

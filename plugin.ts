import type { TokenRingPlugin } from "@tokenring-ai/app";
import { z } from "zod";
import { SocialMediaService } from "../social/index.ts";
import packageJSON from "./package.json" with { type: "json" };
import { XConfigSchema, type XProviderOptions } from "./schema.ts";
import XSocialMediaProvider from "./XSocialMediaProvider.ts";

const packageConfigSchema = z.object({
  x: XConfigSchema.prefault({
    accounts: {},
  }),
});

function addAccountsFromEnv(accounts: Record<string, XProviderOptions>) {
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^X_TOKEN(\d*)$/);
    if (match) {
      if (!value) throw new Error(`Empty environment variable ${key}`);
      const n = match[1];
      const name = process.env[`X_ACCOUNT_NAME${n}`] ?? `X Account ${n}`;
      const bearerToken = value;

      accounts[name] = {
        bearerToken,
      };
    }
  }
}

export default {
  name: packageJSON.name,
  displayName: "X (Twitter) Integration",
  version: packageJSON.version,
  description: packageJSON.description,
  install(app, config) {
    addAccountsFromEnv(config.x.accounts);

    app.services.waitForItemByType(SocialMediaService, socialService => {
      for (const [name, accountConfig] of Object.entries(config.x.accounts)) {
        socialService.registerSocialMediaProvider(name, new XSocialMediaProvider(accountConfig));
      }
    });
  },
  config: packageConfigSchema,
} satisfies TokenRingPlugin<typeof packageConfigSchema>;

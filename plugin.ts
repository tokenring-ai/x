import {TokenRingPlugin} from "@tokenring-ai/app";
import {SocialMediaConfigSchema, SocialMediaService} from "../social/index.ts";
import {z} from "zod";
import packageJSON from "./package.json" with {type: "json"};
import XSocialMediaProvider, {XProviderOptionsSchema} from "./XSocialMediaProvider.ts";

const packageConfigSchema = z.object({
  social: SocialMediaConfigSchema.optional(),
});

export default {
  name: packageJSON.name,
  version: packageJSON.version,
  description: packageJSON.description,
  install(app, config) {
    if (!config.social) return;

    app.services.waitForItemByType(SocialMediaService, socialService => {
      for (const name in config.social!.providers) {
        const provider = config.social!.providers[name];
        if (provider.type === "x") {
          socialService.registerSocialMediaProvider(name, new XSocialMediaProvider(XProviderOptionsSchema.parse(provider)));
        }
      }
    });
  },
  config: packageConfigSchema,
} satisfies TokenRingPlugin<typeof packageConfigSchema>;

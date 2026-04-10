import {z} from "zod";

export const XProviderOptionsSchema = z.object({
  baseUrl: z.string().default("https://api.x.com"),
  bearerToken: z.string(),
  userAgent: z
    .string()
    .default("TokenRing-Writer/1.0 (https://github.com/tokenring/writer)"),
  userId: z.string().optional(),
});

export type XProviderOptions = z.input<typeof XProviderOptionsSchema>;

export const XConfigSchema = z.object({
  accounts: z.record(z.string(), XProviderOptionsSchema),
});

export type XConfig = z.input<typeof XConfigSchema>;

// Photon helper module supports config schema behavior.
import {
  DmPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  buildChannelConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { photonChannelConfigUiHints } from "./config-ui-hints.js";

export const PhotonConfigSchema = z
  .object({
    name: z.string().optional(),
    defaultAccount: z.string().optional(),
    enabled: z.boolean().optional(),
    projectId: z.string().optional(),
    apiKey: buildSecretInputSchema().optional(),
    // v0.1 (Stable) setting, ignored since v0.2; accepted so old configs load.
    projectSecret: buildSecretInputSchema().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    reactions: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    ...ReplyRuntimeConfigSchemaShape,
  })
  .strict()
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message: 'channels.photon.dmPolicy="open" requires channels.photon.allowFrom to include "*"',
    });
  });

export const PhotonChannelConfigSchema = buildChannelConfigSchema(PhotonConfigSchema, {
  uiHints: photonChannelConfigUiHints,
});

// Regenerates channelConfigs.photon in openclaw.plugin.json from the zod
// config schema, so OpenClaw can validate `channels.photon` before the
// plugin runtime loads. Run: npm run sync-manifest
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PhotonChannelConfigSchema } from "../src/config-schema.ts";

const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));

export function buildPhotonChannelConfig() {
  const { $schema: _ignored, ...schema } = PhotonChannelConfigSchema.schema as Record<string, unknown>;
  return {
    schema,
    uiHints: PhotonChannelConfigSchema.uiHints,
    label: "Photon",
    description: "iMessage through Photon",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.channelConfigs = { photon: buildPhotonChannelConfig() };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("openclaw.plugin.json: channelConfigs.photon updated");
}

// OpenClaw entry point: registers the Photon iMessage channel.
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { photonPlugin } from "./src/channel.js";
import { setPhotonRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "photon",
  name: "Photon",
  description: "iMessage channel for OpenClaw through Photon",
  plugin: photonPlugin,
  setRuntime: setPhotonRuntime,
});

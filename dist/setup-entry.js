// Lightweight entry OpenClaw loads for setup while the channel is not configured.
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { photonPlugin } from "./src/channel.js";
export default defineSetupPluginEntry(photonPlugin);

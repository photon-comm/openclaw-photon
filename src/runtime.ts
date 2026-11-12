// Photon plugin module implements runtime behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setPhotonRuntime, getRuntime: getPhotonRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "photon",
    errorMessage: "Photon runtime not initialized",
  });
export { getPhotonRuntime, setPhotonRuntime };

import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
const { setRuntime: setPhotonRuntime, getRuntime: getPhotonRuntime } = createPluginRuntimeStore({
    pluginId: "photon",
    errorMessage: "Photon runtime not initialized",
});
export { getPhotonRuntime, setPhotonRuntime };

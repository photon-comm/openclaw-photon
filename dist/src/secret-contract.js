// Photon plugin module implements secret contract behavior.
import { collectSimpleChannelFieldAssignments, getChannelSurface, } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
export const secretTargetRegistryEntries = [
    {
        id: "channels.photon.apiKey",
        targetType: "channels.photon.apiKey",
        configFile: "openclaw.json",
        pathPattern: "channels.photon.apiKey",
        secretShape: "secret_input",
        expectedResolvedValue: "string",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
    },
];
export function collectRuntimeConfigAssignments(params) {
    const resolved = getChannelSurface(params.config, "photon");
    if (!resolved) {
        return;
    }
    const { channel: photon, surface } = resolved;
    collectSimpleChannelFieldAssignments({
        channelKey: "photon",
        field: "apiKey",
        channel: photon,
        surface,
        defaults: params.defaults,
        context: params.context,
        topInactiveReason: "no enabled account inherits this top-level Photon API key.",
        accountInactiveReason: "Photon account is disabled.",
    });
}
export const channelSecrets = {
    secretTargetRegistryEntries,
    collectRuntimeConfigAssignments,
};

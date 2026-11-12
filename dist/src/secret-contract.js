// Photon plugin module implements secret contract behavior.
import { collectSimpleChannelFieldAssignments, getChannelSurface, } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
export const secretTargetRegistryEntries = [
    {
        id: "channels.photon.projectSecret",
        targetType: "channels.photon.projectSecret",
        configFile: "openclaw.json",
        pathPattern: "channels.photon.projectSecret",
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
        field: "projectSecret",
        channel: photon,
        surface,
        defaults: params.defaults,
        context: params.context,
        topInactiveReason: "no enabled account inherits this top-level Photon project secret.",
        accountInactiveReason: "Photon account is disabled.",
    });
}
export const channelSecrets = {
    secretTargetRegistryEntries,
    collectRuntimeConfigAssignments,
};

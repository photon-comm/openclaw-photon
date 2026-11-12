export const photonChannelConfigUiHints = {
    "": {
        label: "Photon",
        help: "iMessage through Photon Spectrum. Photon hosts the iMessage lines, so no Mac or public URL is needed.",
    },
    projectId: {
        label: "Photon project ID",
        help: "Project ID from your project's Settings at https://app.photon.codes.",
    },
    projectSecret: {
        label: "Photon project secret",
        help: "Project secret from the same Settings page.",
        sensitive: true,
    },
    dmPolicy: {
        label: "DM policy",
        help: 'Who can message the agent. "pairing" (default) asks unknown numbers to pair; "allowlist" only allows allowFrom; "open" needs allowFrom ["*"].',
    },
    allowFrom: {
        label: "Allowed phone numbers",
        help: "Phone numbers in E.164 format (for example +15551234567) that can message the agent.",
    },
    reactions: {
        label: "Tapback status",
        help: "Tapback 👀 while the agent works and 👍 or 👎 when it finishes, and pass your tapbacks on the agent's messages to the agent. Off by default.",
    },
};

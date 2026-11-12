export const photonChannelConfigUiHints = {
    "": {
        label: "Photon",
        help: "iMessage through Photon Beta (2.0). Photon hosts the iMessage lines, so no Mac or public URL is needed.",
    },
    projectId: {
        label: "Photon project ID",
        help: "Project ID (pho_prj_...) from your project's Settings at https://app.beta.photon.codes.",
    },
    apiKey: {
        label: "Photon API key",
        help: "Project API key (pho_sk_...) with project:read, project:write and platforms:read, from API keys at https://app.beta.photon.codes.",
        sensitive: true,
    },
    projectSecret: {
        label: "Spectrum project secret (v0.1)",
        help: "Only used by v0.1, which ran on Photon Stable. v0.2 and later use apiKey instead.",
        sensitive: true,
    },
    dmPolicy: {
        label: "DM policy",
        help: 'Who can message the agent. "pairing" (default) asks unknown numbers to pair; "allowlist" only allows allowFrom; "open" needs allowFrom ["*"].',
    },
    allowFrom: {
        label: "Allowed senders",
        help: "Phone numbers in E.164 format (for example +15551234567) or iMessage emails that can message the agent.",
    },
    reactions: {
        label: "Tapback status",
        help: "Tapback 👀 while the agent works and 👍 or 👎 when it finishes. Off by default.",
    },
};

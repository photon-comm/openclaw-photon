// Photon plugin module implements send behavior.
import { createMessageReceiptFromOutboundResults, } from "openclaw/plugin-sdk/channel-outbound";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { getActivePhotonClient, PhotonClient } from "./client.js";
import { normalizePhotonMessagingTarget } from "./normalize.js";
import { getPhotonRuntime } from "./runtime.js";
import { resolvePhotonAccount } from "./types.js";
function recordPhotonOutboundActivity(accountId) {
    try {
        getPhotonRuntime().channel.activity.record({
            channel: "photon",
            accountId,
            direction: "outbound",
        });
    }
    catch (error) {
        if (!(error instanceof Error) || error.message !== "Photon runtime not initialized") {
            throw error;
        }
    }
}
// iMessage has no table rendering; follow the channel's markdown.tables
// setting when the runtime is available (it is in the gateway and CLI).
function preparePhotonText(text, cfg, accountId) {
    const trimmed = text.trim();
    if (!trimmed) {
        return trimmed;
    }
    try {
        const textRuntime = getPhotonRuntime().channel.text;
        const mode = textRuntime.resolveMarkdownTableMode({ cfg, channel: "photon", accountId });
        return textRuntime.convertMarkdownTables(trimmed, mode);
    }
    catch {
        return trimmed;
    }
}
async function withPhotonClient(params, run) {
    const active = getActivePhotonClient(params.accountId);
    if (active) {
        return await run(active);
    }
    // No gateway monitor running (for example one-off CLI sends): open a
    // transient connection and close it after the send.
    const transient = await PhotonClient.connect({
        projectId: params.projectId,
        projectSecret: params.projectSecret,
    });
    try {
        return await run(transient);
    }
    finally {
        await transient.stop().catch(() => { });
    }
}
export async function sendMessagePhoton(to, text, opts) {
    const cfg = requireRuntimeConfig(opts.cfg, "Photon send");
    const account = resolvePhotonAccount({ cfg, accountId: opts.accountId });
    if (!account.configured) {
        throw new Error(`Photon is not configured for account "${account.accountId}" (need projectId and projectSecret in channels.photon).`);
    }
    const target = normalizePhotonMessagingTarget(to);
    if (!target) {
        throw new Error(`Invalid Photon target: ${to}`);
    }
    const prepared = preparePhotonText(text, cfg, account.accountId);
    const mediaUrl = opts.mediaUrl?.trim();
    if (!prepared && !mediaUrl) {
        throw new Error("Message must include text or media for Photon sends");
    }
    const result = await withPhotonClient({
        accountId: account.accountId,
        projectId: account.projectId,
        projectSecret: account.projectSecret,
    }, async (client) => mediaUrl
        ? await client.sendMedia(target, { url: mediaUrl }, prepared || undefined)
        : await client.sendText(target, prepared));
    recordPhotonOutboundActivity(account.accountId);
    const messageId = result.messageId ?? `photon-${Date.now()}`;
    return {
        messageId,
        conversationId: result.spaceId,
        target: { kind: "chat", id: target },
        receipt: createMessageReceiptFromOutboundResults({
            results: [
                {
                    channel: "photon",
                    messageId,
                    conversationId: result.spaceId,
                },
            ],
            kind: mediaUrl ? "media" : "text",
        }),
    };
}

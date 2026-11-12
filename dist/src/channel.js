// Photon plugin module implements channel behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import { createScopedDmSecurityResolver, createTopLevelChannelConfigAdapter, } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { createComputedAccountStatusAdapter, createDefaultChannelRuntimeState, } from "openclaw/plugin-sdk/status-helpers";
import { DEFAULT_ACCOUNT_ID, buildBaseChannelStatusSummary } from "./channel-api.js";
import { PhotonChannelConfigSchema } from "./config-schema.js";
import { loadPhotonChannelRuntime, startPhotonGatewayAccount } from "./gateway.js";
import { looksLikePhotonTargetId, normalizePhotonAllowEntry, normalizePhotonMessagingTarget, } from "./normalize.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { photonSetupAdapter, photonSetupWizard } from "./setup-surface.js";
import { listPhotonAccountIds, resolveDefaultPhotonAccountId, resolvePhotonAccount, } from "./types.js";
const meta = {
    id: "photon",
    label: "Photon",
    // Keep in sync with `openclaw.channel` in package.json, which OpenClaw reads
    // before the plugin loads.
    selectionLabel: "Photon (iMessage, no Mac)",
    docsPath: "https://github.com/photon-hq/openclaw-photon#readme",
    docsLabel: "photon",
    blurb: "iMessage through Photon Spectrum. Sign in with Photon and get a line to text, no Mac or public URL needed.",
    order: 57,
    detailLabel: "Photon iMessage",
    systemImage: "message",
    markdownCapable: true,
};
const photonConfigAdapter = createTopLevelChannelConfigAdapter({
    sectionKey: "photon",
    resolveAccount: (cfg) => resolvePhotonAccount({ cfg }),
    listAccountIds: listPhotonAccountIds,
    defaultAccountId: resolveDefaultPhotonAccountId,
    deleteMode: "clear-fields",
    clearBaseFields: [
        "name",
        "defaultAccount",
        "projectId",
        "projectSecret",
        "dmPolicy",
        "allowFrom",
        "defaultTo",
        "reactions",
    ],
    resolveAllowFrom: (account) => account.config.allowFrom,
    formatAllowFrom: (allowFrom) => formatNormalizedAllowFromEntries({
        allowFrom,
        normalizeEntry: normalizePhotonAllowEntry,
    }),
    resolveDefaultTo: (account) => account.config.defaultTo,
});
const resolvePhotonDmPolicy = createScopedDmSecurityResolver({
    channelKey: "photon",
    resolvePolicy: (account) => account.config.dmPolicy,
    resolveAllowFrom: (account) => account.config.allowFrom,
    policyPathSuffix: "dmPolicy",
    defaultPolicy: "pairing",
    normalizeEntry: (raw) => normalizePhotonAllowEntry(raw),
});
const photonMessageAdapter = defineChannelMessageAdapter({
    id: "photon",
    durableFinal: {
        capabilities: {
            text: true,
            media: true,
        },
    },
    send: {
        text: async ({ cfg, to, text, accountId }) => {
            const { sendMessagePhoton } = await loadPhotonChannelRuntime();
            return await sendMessagePhoton(to, text, {
                cfg: cfg,
                accountId: accountId ?? undefined,
            });
        },
        media: async ({ cfg, to, text, mediaUrl, accountId }) => {
            const { sendMessagePhoton } = await loadPhotonChannelRuntime();
            return await sendMessagePhoton(to, text, {
                cfg: cfg,
                accountId: accountId ?? undefined,
                mediaUrl: mediaUrl ?? undefined,
            });
        },
    },
});
export const photonPlugin = createChatChannelPlugin({
    base: {
        id: "photon",
        meta: {
            ...meta,
            quickstartAllowFrom: true,
        },
        capabilities: {
            // Photon does not support group chats; iMessage DMs only.
            chatTypes: ["direct"],
            media: true,
            blockStreaming: true,
            reactions: true,
        },
        reload: { configPrefixes: ["channels.photon"] },
        configSchema: PhotonChannelConfigSchema,
        setup: photonSetupAdapter,
        setupWizard: photonSetupWizard,
        config: {
            ...photonConfigAdapter,
            hasConfiguredState: ({ env }) => typeof env?.PHOTON_PROJECT_ID === "string" &&
                env.PHOTON_PROJECT_ID.trim().length > 0 &&
                typeof env?.PHOTON_PROJECT_SECRET === "string" &&
                env.PHOTON_PROJECT_SECRET.trim().length > 0,
            isConfigured: (account) => account.configured,
            describeAccount: (account) => describeAccountSnapshot({
                account,
                configured: account.configured,
                extra: {
                    projectId: account.projectId,
                },
            }),
        },
        messaging: {
            targetPrefixes: ["photon"],
            normalizeTarget: normalizePhotonMessagingTarget,
            targetResolver: {
                looksLikeId: looksLikePhotonTargetId,
                hint: "<+E.164 phone>",
            },
        },
        message: photonMessageAdapter,
        secrets: {
            secretTargetRegistryEntries,
            collectRuntimeConfigAssignments,
        },
        status: createComputedAccountStatusAdapter({
            defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
            buildChannelSummary: ({ account, snapshot }) => ({
                ...buildBaseChannelStatusSummary(snapshot),
                projectId: account.projectId,
                probe: snapshot.probe,
                lastProbeAt: snapshot.lastProbeAt ?? null,
            }),
            probeAccount: async ({ cfg, account, timeoutMs }) => {
                const { probePhoton } = await loadPhotonChannelRuntime();
                return await probePhoton(cfg, {
                    accountId: account.accountId,
                    timeoutMs,
                });
            },
            resolveAccountSnapshot: ({ account }) => ({
                accountId: account.accountId,
                name: account.name,
                enabled: account.enabled,
                configured: account.configured,
                extra: {
                    projectId: account.projectId,
                },
            }),
        }),
        gateway: {
            startAccount: async (ctx) => await startPhotonGatewayAccount({
                ...ctx,
                cfg: ctx.cfg,
            }),
        },
    },
    pairing: {
        text: {
            idLabel: "photonSender",
            message: PAIRING_APPROVED_MESSAGE,
            normalizeAllowEntry: (entry) => normalizePhotonAllowEntry(entry),
            notify: async ({ cfg, id, message, accountId }) => {
                const target = normalizePhotonMessagingTarget(id);
                if (!target) {
                    throw new Error(`invalid Photon pairing id: ${id}`);
                }
                const { sendMessagePhoton } = await loadPhotonChannelRuntime();
                await sendMessagePhoton(target, message, {
                    cfg: cfg,
                    accountId: accountId ?? undefined,
                });
            },
        },
    },
    security: {
        resolveDmPolicy: resolvePhotonDmPolicy,
    },
    outbound: {
        base: {
            deliveryMode: "direct",
            textChunkLimit: 4000,
        },
        attachedResults: {
            channel: "photon",
            sendText: async ({ cfg, to, text, accountId }) => {
                const { sendMessagePhoton } = await loadPhotonChannelRuntime();
                return await sendMessagePhoton(to, text, {
                    cfg: cfg,
                    accountId: accountId ?? undefined,
                });
            },
            sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
                const { sendMessagePhoton } = await loadPhotonChannelRuntime();
                return await sendMessagePhoton(to, text, {
                    cfg: cfg,
                    accountId: accountId ?? undefined,
                    mediaUrl: mediaUrl ?? undefined,
                });
            },
        },
    },
});

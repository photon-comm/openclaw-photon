// Photon plugin module implements monitor behavior.
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { clearActivePhotonClient, normalizePhotonContent, PhotonClient, readPhotonReactionContent, setActivePhotonClient, } from "./client.js";
import { handlePhotonInbound, handlePhotonReaction } from "./inbound.js";
import { phoneTargetFromSpaceId } from "./normalize.js";
import { getPhotonRuntime } from "./runtime.js";
import { resolvePhotonAccount } from "./types.js";
const DEFAULT_MEDIA_MAX_MB = 20;
// Spectrum gRPC reconnects can replay recent messages; a bounded seen-id set
// keeps a catch-up burst from dispatching duplicate agent turns.
const MAX_SEEN_MESSAGE_IDS = 1024;
const RESUBSCRIBE_BACKOFF_MAX_MS = 30_000;
function rememberSeenMessageId(seen, id) {
    if (seen.has(id)) {
        return false;
    }
    seen.add(id);
    if (seen.size > MAX_SEEN_MESSAGE_IDS) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) {
            seen.delete(oldest);
        }
    }
    return true;
}
async function stagePhotonAttachments(attachments, params) {
    const media = [];
    const placeholders = [];
    for (const item of attachments) {
        if (!item.buffer) {
            if (item.placeholder) {
                placeholders.push(item.placeholder);
            }
            continue;
        }
        try {
            const saved = await saveMediaBuffer(item.buffer, item.mimeType, "inbound", params.maxBytes, item.name);
            media.push({ path: saved.path, contentType: saved.contentType });
        }
        catch (err) {
            params.logVerbose(`photon: failed to stage inbound media: ${String(err)}`);
            placeholders.push(`[Photon ${item.kind === "voice" ? "voice note" : "attachment"} received: ${item.name ?? "(unnamed)"}]`);
        }
    }
    return { media, placeholders };
}
export async function monitorPhotonProvider(opts) {
    const core = getPhotonRuntime();
    const cfg = opts.config ?? core.config.current();
    const account = resolvePhotonAccount({ cfg, accountId: opts.accountId });
    const runtime = resolveLoggerBackedRuntime(opts.runtime, core.logging.getChildLogger());
    if (!account.configured) {
        throw new Error(`Photon is not configured for account "${account.accountId}" (need projectId and projectSecret in channels.photon).`);
    }
    const logger = core.logging.getChildLogger({
        channel: "photon",
        accountId: account.accountId,
    });
    const logVerbose = (message) => {
        if (core.logging.shouldLogVerbose()) {
            logger.debug?.(message);
        }
    };
    const client = await PhotonClient.connect({
        projectId: account.projectId,
        projectSecret: account.projectSecret,
    });
    setActivePhotonClient(account.accountId, client);
    const maxBytes = Math.max(account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB, 1) * 1024 * 1024;
    const seenMessageIds = new Set();
    let stopped = false;
    const handleEvent = async (space, message) => {
        // Skip our own outbound echoes.
        if (message.direction && message.direction !== "inbound") {
            return;
        }
        if (!message.id || !rememberSeenMessageId(seenMessageIds, message.id)) {
            return;
        }
        // Photon does not support group chats; only DM spaces dispatch.
        if (space.type === "group") {
            logVerbose(`[${account.accountId}] photon: ignoring group-space message ${message.id} (groups unsupported)`);
            return;
        }
        client.rememberSpace(space);
        // Keep the live handle so status tapbacks can react to this message.
        client.rememberMessage(message);
        const spacePhone = space.phone ?? phoneTargetFromSpaceId(space.id) ?? undefined;
        const senderId = message.sender?.id ?? spacePhone ?? "";
        if (!senderId) {
            logVerbose(`[${account.accountId}] photon: dropping message ${message.id} without sender`);
            return;
        }
        const timestamp = message.timestamp instanceof Date ? message.timestamp.getTime() : Date.now();
        const reactionFacts = readPhotonReactionContent(message.content);
        if (reactionFacts) {
            // Only tapbacks on the agent's own messages reach the agent; provider
            // hydration of target.direction wins, sent-id cache covers the rest.
            const targetsOwnMessage = reactionFacts.targetDirection === "outbound" ||
                client.isOwnMessageId(reactionFacts.targetMessageId);
            if (!targetsOwnMessage) {
                logVerbose(`[${account.accountId}] photon: ignoring reaction on non-agent message ${reactionFacts.targetMessageId ?? "(unknown)"}`);
                return;
            }
            await handlePhotonReaction({
                reaction: {
                    messageId: message.id,
                    spaceId: space.id,
                    spacePhone,
                    senderId,
                    emoji: reactionFacts.emoji,
                    targetMessageId: reactionFacts.targetMessageId,
                    timestamp,
                },
                account,
                config: cfg,
                runtime,
            });
            return;
        }
        const normalized = await normalizePhotonContent(message.content, {
            maxBytes,
            onReadError: (err) => {
                logger.error(`[${account.accountId}] photon media read failed: ${String(err)}`);
            },
        });
        if (!normalized) {
            logVerbose(`[${account.accountId}] photon: ignoring inbound content type ${message.content.type}`);
            return;
        }
        const staged = await stagePhotonAttachments(normalized.attachments, {
            maxBytes,
            logVerbose,
        });
        core.channel.activity.record({
            channel: "photon",
            accountId: account.accountId,
            direction: "inbound",
        });
        await handlePhotonInbound({
            message: {
                messageId: message.id,
                spaceId: space.id,
                spacePhone,
                senderId,
                text: normalized.text,
                media: staged.media,
                mediaPlaceholders: staged.placeholders,
                timestamp,
            },
            account,
            config: cfg,
            runtime,
            statusSink: opts.statusSink,
        });
    };
    // Each conversation runs in order, but one long agent turn must not hold up
    // other senders, their tapbacks or pairing replies.
    const spaceQueues = new Map();
    const enqueueEvent = (space, message) => {
        const key = space.id || message.sender?.id || "";
        const previous = spaceQueues.get(key) ?? Promise.resolve();
        const next = previous
            .then(() => handleEvent(space, message))
            .catch((err) => {
            logger.error(`[${account.accountId}] photon inbound handler failed: ${String(err)}`);
        })
            .finally(() => {
            if (spaceQueues.get(key) === next) {
                spaceQueues.delete(key);
            }
        });
        spaceQueues.set(key, next);
    };
    // spectrum-ts reconnects gRPC internally, but if the message iterator itself
    // throws or ends this consumer would stop forever. Re-subscribe with capped
    // backoff plus jitter; the seen-id set absorbs any catch-up replay.
    void (async () => {
        let backoff = 1000;
        for (;;) {
            if (stopped || opts.abortSignal?.aborted) {
                break;
            }
            try {
                for await (const [space, message] of client.messages) {
                    if (stopped || opts.abortSignal?.aborted) {
                        break;
                    }
                    backoff = 1000;
                    enqueueEvent(space, message);
                }
                if (!stopped) {
                    logger.info(`[${account.accountId}] photon inbound stream ended; re-subscribing`);
                }
            }
            catch (err) {
                if (!stopped) {
                    logger.error(`[${account.accountId}] photon inbound stream errored; restarting: ${String(err)}`);
                }
            }
            if (stopped || opts.abortSignal?.aborted) {
                break;
            }
            await new Promise((resolve) => {
                setTimeout(resolve, backoff + Math.random() * backoff * 0.2);
            });
            backoff = Math.min(backoff * 2, RESUBSCRIBE_BACKOFF_MAX_MS);
        }
    })();
    logger.info(`[${account.accountId}] photon connected (project ${account.projectId})`);
    return {
        stop: () => {
            if (stopped) {
                return;
            }
            stopped = true;
            clearActivePhotonClient(account.accountId, client);
            void client.stop().catch((err) => {
                logger.error(`[${account.accountId}] photon stop failed: ${String(err)}`);
            });
        },
    };
}

// Photon plugin module implements the Spectrum client behavior.
//
// Wraps the `spectrum-ts` SDK: one long-lived gRPC connection per gateway
// account for inbound `app.messages` plus outbound `space.send(...)`. This
// module is heavy (gRPC/protobuf) and must only load through the lazy
// `channel-runtime.ts` boundary, never from cold plugin discovery paths.
import { attachment, markdown, Spectrum, text as textContent } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { phoneTargetFromSpaceId } from "./normalize.js";
/** Read tapback facts from inbound reaction content; null for other content. */
export function readPhotonReactionContent(content) {
    if (content.type !== "reaction") {
        return null;
    }
    const reaction = content;
    const emoji = reaction.emoji?.trim();
    if (!emoji) {
        return null;
    }
    const direction = reaction.target?.direction;
    return {
        emoji,
        targetMessageId: reaction.target?.id,
        targetDirection: direction === "inbound" || direction === "outbound" ? direction : undefined,
    };
}
const MAX_KNOWN_SPACES = 2048;
const MAX_KNOWN_MESSAGES = 1024;
// One live gateway client per account; CLI sends reuse it instead of opening a
// second gRPC stream (Spectrum delivers inbound to every subscriber, so a
// parallel connection would double-consume messages).
const activeClients = new Map();
export function getActivePhotonClient(accountId) {
    return activeClients.get(accountId);
}
export function setActivePhotonClient(accountId, client) {
    activeClients.set(accountId, client);
}
export function clearActivePhotonClient(accountId, client) {
    if (activeClients.get(accountId) === client) {
        activeClients.delete(accountId);
    }
}
export class PhotonClient {
    app;
    im;
    // Spaces from inbound traffic are remembered by id and phone so outbound
    // sends reuse live handles instead of re-resolving each time.
    knownSpaces = new Map();
    // Inbound Message handles by id; tapbacks need a live handle because
    // `react()` lives on the Message object, not on a bare id.
    knownMessages = new Map();
    // Outbound message ids so inbound tapbacks can be gated to "reacted to one
    // of MY messages" even when the provider does not hydrate target.direction.
    sentMessageIds = new Set();
    constructor(app, im) {
        this.app = app;
        this.im = im;
    }
    static async connect(options) {
        const app = await Spectrum({
            projectId: options.projectId,
            projectSecret: options.projectSecret,
            providers: [imessage.config()],
            // Inbound group bundles are flattened so each item keeps its own
            // id/sender and dedupe works per message.
            options: { flattenGroups: true },
            telemetry: false,
        });
        const instantiate = imessage;
        return new PhotonClient(app, instantiate(app));
    }
    get messages() {
        return this.app.messages;
    }
    rememberSpace(space) {
        for (const key of [space.id, phoneTargetFromSpaceId(space.id ?? ""), space.phone]) {
            if (!key) {
                continue;
            }
            if (this.knownSpaces.has(key)) {
                this.knownSpaces.delete(key);
            }
            this.knownSpaces.set(key, space);
            if (this.knownSpaces.size > MAX_KNOWN_SPACES) {
                const oldest = this.knownSpaces.keys().next().value;
                if (oldest !== undefined) {
                    this.knownSpaces.delete(oldest);
                }
            }
        }
    }
    rememberMessage(message) {
        if (!message.id || typeof message.react !== "function") {
            return;
        }
        if (this.knownMessages.has(message.id)) {
            this.knownMessages.delete(message.id);
        }
        this.knownMessages.set(message.id, message);
        if (this.knownMessages.size > MAX_KNOWN_MESSAGES) {
            const oldest = this.knownMessages.keys().next().value;
            if (oldest !== undefined) {
                this.knownMessages.delete(oldest);
            }
        }
    }
    rememberSentMessageId(messageId) {
        if (!messageId) {
            return;
        }
        this.sentMessageIds.add(messageId);
        if (this.sentMessageIds.size > MAX_KNOWN_MESSAGES) {
            const oldest = this.sentMessageIds.values().next().value;
            if (oldest !== undefined) {
                this.sentMessageIds.delete(oldest);
            }
        }
    }
    isOwnMessageId(messageId) {
        return Boolean(messageId && this.sentMessageIds.has(messageId));
    }
    /**
     * Tapback an inbound message by id. iMessage keeps one tapback per sender
     * per message, so a later react replaces the earlier one (👀 -> 👍/👎).
     * Returns false when the message handle is no longer cached.
     */
    async react(messageId, emoji) {
        const handle = this.knownMessages.get(messageId);
        if (!handle?.react) {
            return false;
        }
        return (await handle.react(emoji)) !== undefined;
    }
    async setTyping(target, state) {
        const space = await this.resolveSpace(target);
        if (state === "start") {
            await space.startTyping?.();
        }
        else {
            await space.stopTyping?.();
        }
    }
    /**
     * Resolve a send target to a live space. Bare E.164 phones (and DM chat
     * guids) address DMs via `space.create`; opaque DM space guids rehydrate via
     * `space.get`, so conversations stay reachable across gateway restarts.
     */
    async resolveSpace(target) {
        const cached = this.knownSpaces.get(target);
        if (cached) {
            return cached;
        }
        const phone = phoneTargetFromSpaceId(target);
        const space = phone ? await this.im.space.create(phone) : await this.im.space.get(target);
        this.rememberSpace(space);
        if (!this.knownSpaces.has(target)) {
            this.knownSpaces.set(target, space);
        }
        return space;
    }
    async sendText(target, body, opts) {
        const space = await this.resolveSpace(target);
        const builder = (opts?.format ?? "markdown") === "markdown" ? markdown(body) : textContent(body);
        const result = await space.send(builder);
        this.rememberSentMessageId(result?.id ?? null);
        return { messageId: result?.id ?? null, spaceId: space.id };
    }
    async sendMedia(target, media, caption) {
        const space = await this.resolveSpace(target);
        const input = /^https?:\/\//i.test(media.url) ? new URL(media.url) : media.url;
        const opts = {
            ...(media.name ? { name: media.name } : {}),
            ...(media.mimeType ? { mimeType: media.mimeType } : {}),
        };
        const result = await space.send(attachment(input, Object.keys(opts).length > 0 ? opts : undefined));
        this.rememberSentMessageId(result?.id ?? null);
        // iMessage delivers the caption as a separate bubble; send it after the
        // media so the attachment renders first.
        if (caption?.trim()) {
            try {
                const captionResult = await space.send(markdown(caption));
                this.rememberSentMessageId(captionResult?.id ?? null);
            }
            catch (err) {
                // The attachment is already delivered; failing here would invite a
                // retry that sends it twice.
                console.warn(`photon: caption send failed after media delivery: ${String(err)}`);
            }
        }
        return { messageId: result?.id ?? null, spaceId: space.id };
    }
    async stop() {
        await this.app.stop();
    }
}
function isBinaryContent(content) {
    return ((content.type === "attachment" || content.type === "voice") &&
        typeof content.read === "function");
}
/**
 * Normalize inbound Spectrum content. Binary content is read eagerly because
 * Spectrum content objects may not outlive the stream iteration; oversize or
 * unreadable media degrades to a text marker instead of breaking the loop.
 */
export async function normalizePhotonContent(content, opts) {
    if (content.type === "text") {
        return { text: content.text ?? "", attachments: [] };
    }
    if (content.type === "markdown") {
        return { text: content.markdown ?? "", attachments: [] };
    }
    if (content.type === "richlink") {
        return { text: content.url ?? "", attachments: [] };
    }
    if (isBinaryContent(content)) {
        const kind = content.type;
        const label = content.name ?? content.id ?? "(unnamed)";
        const placeholder = `[Photon ${kind === "voice" ? "voice note" : "attachment"} received: ${label}]`;
        if (typeof content.size === "number" && content.size > opts.maxBytes) {
            return { text: "", attachments: [{ kind, placeholder }] };
        }
        try {
            const buffer = await content.read();
            if (buffer.length > opts.maxBytes) {
                return { text: "", attachments: [{ kind, placeholder }] };
            }
            return {
                text: "",
                attachments: [{ kind, buffer, name: content.name, mimeType: content.mimeType }],
            };
        }
        catch (err) {
            opts.onReadError?.(err);
            return { text: "", attachments: [{ kind, placeholder }] };
        }
    }
    return null;
}

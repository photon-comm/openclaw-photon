// One Photon client per gateway account: the project API plus what the
// gateway remembers (cursor, handled ids, conversations). The gateway's
// client is registered so CLI and agent sends reuse its conversation cache;
// without a running gateway a send builds a short-lived client.
import { describePhotonError, photonErrorCode, PhotonProjectApi, } from "./api.js";
import { normalizePhotonHandle } from "./normalize.js";
import { PhotonStateStore } from "./state.js";
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
// A cached Space that Photon no longer accepts is looked up again once.
const STALE_CONVERSATION_CODES = new Set([
    "SPACE_NOT_FOUND",
    "SENDER_NOT_FOUND",
    "SPACE_NOT_SENDABLE",
    "SENDER_NOT_SENDABLE",
]);
export class PhotonClient {
    options;
    api;
    state;
    constructor(options) {
        this.options = options;
        this.api = new PhotonProjectApi(options.projectId, options.apiKey, {
            origin: options.origin,
            fetch: options.fetch,
        });
        this.state = new PhotonStateStore(options.stateFile, options.projectId);
    }
    get projectId() {
        return this.options.projectId;
    }
    /** Remember the DM an inbound message arrived in, so replies need no lookup. */
    rememberConversation(handle, conversation) {
        this.state.setConversation(normalizePhotonHandle(handle), conversation);
    }
    async conversationFor(handle) {
        const key = normalizePhotonHandle(handle);
        const cached = this.state.getConversation(key);
        if (cached) {
            return cached;
        }
        const resolved = await this.api.resolveConversation(key);
        this.state.setConversation(key, resolved);
        return resolved;
    }
    async withConversation(handle, run) {
        const key = normalizePhotonHandle(handle);
        const conversation = await this.conversationFor(key);
        try {
            return await run(conversation);
        }
        catch (err) {
            const code = photonErrorCode(err);
            if (!code || !STALE_CONVERSATION_CODES.has(code)) {
                throw err;
            }
            this.state.forgetConversation(key);
            return await run(await this.conversationFor(key));
        }
    }
    async sendText(handle, text) {
        return await this.withConversation(handle, async (conversation) => {
            const sent = await this.api.sendText(conversation, text);
            return { messageId: sent.id, spaceId: conversation.spaceId };
        });
    }
    async sendFile(handle, file) {
        return await this.withConversation(handle, async (conversation) => {
            const sent = await this.api.sendFile(conversation, file);
            return { messageId: sent.id, spaceId: conversation.spaceId };
        });
    }
    async setTyping(handle, typing) {
        const conversation = await this.conversationFor(handle);
        await this.api.setTyping(conversation, typing);
    }
    async markRead(messageId) {
        await this.api.markRead(messageId);
    }
}
export { describePhotonError };

// One Photon client per gateway account: the project API plus what the
// gateway remembers (cursor, handled ids, conversations). The gateway's
// client is registered so CLI and agent sends reuse its conversation cache;
// without a running gateway a send builds a short-lived client.
import {
  describePhotonError,
  photonErrorCode,
  PhotonProjectApi,
  type PhotonConversation,
  type PhotonOutboundFile,
} from "./api.js";
import { normalizePhotonHandle } from "./normalize.js";
import { PhotonStateStore } from "./state.js";

export type PhotonClientOptions = {
  accountId: string;
  projectId: string;
  apiKey: string;
  /** State file; omit to keep nothing on disk (one-off CLI sends). */
  stateFile?: string;
  origin?: string;
  fetch?: typeof globalThis.fetch;
  /** Reports a state file that can't be written. */
  onStateError?: (err: unknown) => void;
};

export type PhotonSendResult = {
  messageId: string | null;
  spaceId: string;
};

const activeClients = new Map<string, PhotonClient>();

export function getActivePhotonClient(accountId: string): PhotonClient | undefined {
  return activeClients.get(accountId);
}

export function setActivePhotonClient(accountId: string, client: PhotonClient): void {
  activeClients.set(accountId, client);
}

export function clearActivePhotonClient(accountId: string, client: PhotonClient): void {
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
  readonly api: PhotonProjectApi;
  readonly state: PhotonStateStore;

  constructor(readonly options: PhotonClientOptions) {
    this.api = new PhotonProjectApi(options.projectId, options.apiKey, {
      origin: options.origin,
      fetch: options.fetch,
    });
    this.state = new PhotonStateStore(options.stateFile, options.projectId, options.onStateError);
  }

  get projectId(): string {
    return this.options.projectId;
  }

  /** Remember the DM an inbound message arrived in, so replies need no lookup. */
  rememberConversation(handle: string, conversation: PhotonConversation): void {
    this.state.setConversation(normalizePhotonHandle(handle), conversation);
  }

  async conversationFor(handle: string): Promise<PhotonConversation> {
    const key = normalizePhotonHandle(handle);
    const cached = this.state.getConversation(key);
    if (cached) {
      return cached;
    }
    const resolved = await this.api.resolveConversation(key);
    this.state.setConversation(key, resolved);
    return resolved;
  }

  private async withConversation<T>(
    handle: string,
    run: (conversation: PhotonConversation) => Promise<T>,
  ): Promise<T> {
    const key = normalizePhotonHandle(handle);
    const conversation = await this.conversationFor(key);
    try {
      return await run(conversation);
    } catch (err) {
      const code = photonErrorCode(err);
      if (!code || !STALE_CONVERSATION_CODES.has(code)) {
        throw err;
      }
      this.state.forgetConversation(key);
      return await run(await this.conversationFor(key));
    }
  }

  async sendText(handle: string, text: string): Promise<PhotonSendResult> {
    return await this.withConversation(handle, async (conversation) => {
      const sent = await this.api.sendText(conversation, text);
      return { messageId: sent.id, spaceId: conversation.spaceId };
    });
  }

  async sendFile(handle: string, file: PhotonOutboundFile): Promise<PhotonSendResult> {
    return await this.withConversation(handle, async (conversation) => {
      const sent = await this.api.sendFile(conversation, file);
      return { messageId: sent.id, spaceId: conversation.spaceId };
    });
  }

  async setTyping(handle: string, typing: boolean): Promise<void> {
    const conversation = await this.conversationFor(handle);
    await this.api.setTyping(conversation, typing);
  }

  async markRead(messageId: string): Promise<void> {
    await this.api.markRead(messageId);
  }
}

export { describePhotonError };

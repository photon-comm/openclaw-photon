// Photon plugin module implements the Spectrum client behavior.
//
// Wraps the `spectrum-ts` SDK: one long-lived gRPC connection per gateway
// account for inbound `app.messages` plus outbound `space.send(...)`. This
// module is heavy (gRPC/protobuf) and must only load through the lazy
// `channel-runtime.ts` boundary, never from cold plugin discovery paths.
import { attachment, markdown, Spectrum, text as textContent } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { phoneTargetFromSpaceId } from "./normalize.js";

export type PhotonSpace = {
  id: string;
  type?: "dm" | "group";
  phone?: string;
  send: (content: unknown) => Promise<{ id: string } | undefined>;
  startTyping?: () => Promise<void>;
  stopTyping?: () => Promise<void>;
};

export type PhotonSpectrumMessage = {
  id: string;
  direction?: "inbound" | "outbound";
  content: PhotonInboundContent;
  sender?: { id: string };
  timestamp?: Date;
  /** Tapback on this message; resolves undefined when unsupported. */
  react?: (emoji: string) => Promise<unknown>;
};

type PhotonBinaryContent = {
  type: "attachment" | "voice";
  id?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  read: () => Promise<Buffer>;
};

export type PhotonInboundContent =
  | { type: "text"; text?: string }
  | { type: "markdown"; markdown?: string }
  | { type: "richlink"; url?: string }
  | PhotonBinaryContent
  | { type: "reaction"; emoji?: string; target?: { id?: string; direction?: string } }
  | { type: string };

export type PhotonReactionFacts = {
  emoji: string;
  targetMessageId?: string;
  targetDirection?: "inbound" | "outbound";
};

/** Read tapback facts from inbound reaction content; null for other content. */
export function readPhotonReactionContent(
  content: PhotonInboundContent,
): PhotonReactionFacts | null {
  if (content.type !== "reaction") {
    return null;
  }
  const reaction = content as Extract<PhotonInboundContent, { type: "reaction" }>;
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

// Narrow adapters over spectrum-ts' generic (hotscript-typed) surfaces; the
// plugin only needs the message stream, space resolution, send, and stop.
type SpectrumAppLike = {
  messages: AsyncIterable<[PhotonSpace, PhotonSpectrumMessage]>;
  stop: () => Promise<void>;
};
type IMessageInstanceLike = {
  space: {
    create: (user: string) => Promise<PhotonSpace>;
    get: (id: string) => Promise<PhotonSpace>;
  };
};

export type PhotonInboundAttachment = {
  kind: "attachment" | "voice";
  buffer?: Buffer;
  name?: string;
  mimeType?: string;
  /** Marker text used when bytes were not inlined (oversize or read failure). */
  placeholder?: string;
};

export type PhotonNormalizedContent = {
  text: string;
  attachments: PhotonInboundAttachment[];
};

export type PhotonSendResult = {
  messageId: string | null;
  spaceId: string;
};

export type PhotonClientOptions = {
  projectId: string;
  projectSecret: string;
};

const MAX_KNOWN_SPACES = 2048;
const MAX_KNOWN_MESSAGES = 1024;

// One live gateway client per account; CLI sends reuse it instead of opening a
// second gRPC stream (Spectrum delivers inbound to every subscriber, so a
// parallel connection would double-consume messages).
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

export class PhotonClient {
  // Spaces from inbound traffic are remembered by id and phone so outbound
  // sends reuse live handles instead of re-resolving each time.
  private readonly knownSpaces = new Map<string, PhotonSpace>();
  // Inbound Message handles by id; tapbacks need a live handle because
  // `react()` lives on the Message object, not on a bare id.
  private readonly knownMessages = new Map<string, PhotonSpectrumMessage>();
  // Outbound message ids so inbound tapbacks can be gated to "reacted to one
  // of MY messages" even when the provider does not hydrate target.direction.
  private readonly sentMessageIds = new Set<string>();

  private constructor(
    private readonly app: SpectrumAppLike,
    private readonly im: IMessageInstanceLike,
  ) {}

  static async connect(options: PhotonClientOptions): Promise<PhotonClient> {
    const app = await Spectrum({
      projectId: options.projectId,
      projectSecret: options.projectSecret,
      providers: [imessage.config()],
      // Inbound group bundles are flattened so each item keeps its own
      // id/sender and dedupe works per message.
      options: { flattenGroups: true },
      telemetry: false,
    });
    const instantiate = imessage as unknown as (spectrum: unknown) => IMessageInstanceLike;
    return new PhotonClient(app as unknown as SpectrumAppLike, instantiate(app));
  }

  get messages(): AsyncIterable<[PhotonSpace, PhotonSpectrumMessage]> {
    return this.app.messages;
  }

  rememberSpace(space: PhotonSpace): void {
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

  rememberMessage(message: PhotonSpectrumMessage): void {
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

  private rememberSentMessageId(messageId: string | null): void {
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

  isOwnMessageId(messageId: string | undefined): boolean {
    return Boolean(messageId && this.sentMessageIds.has(messageId));
  }

  /**
   * Tapback an inbound message by id. iMessage keeps one tapback per sender
   * per message, so a later react replaces the earlier one (👀 -> 👍/👎).
   * Returns false when the message handle is no longer cached.
   */
  async react(messageId: string, emoji: string): Promise<boolean> {
    const handle = this.knownMessages.get(messageId);
    if (!handle?.react) {
      return false;
    }
    return (await handle.react(emoji)) !== undefined;
  }

  async setTyping(target: string, state: "start" | "stop"): Promise<void> {
    const space = await this.resolveSpace(target);
    if (state === "start") {
      await space.startTyping?.();
    } else {
      await space.stopTyping?.();
    }
  }

  /**
   * Resolve a send target to a live space. Bare E.164 phones (and DM chat
   * guids) address DMs via `space.create`; opaque DM space guids rehydrate via
   * `space.get`, so conversations stay reachable across gateway restarts.
   */
  async resolveSpace(target: string): Promise<PhotonSpace> {
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

  async sendText(
    target: string,
    body: string,
    opts?: { format?: "markdown" | "text" },
  ): Promise<PhotonSendResult> {
    const space = await this.resolveSpace(target);
    const builder =
      (opts?.format ?? "markdown") === "markdown" ? markdown(body) : textContent(body);
    const result = await space.send(builder);
    this.rememberSentMessageId(result?.id ?? null);
    return { messageId: result?.id ?? null, spaceId: space.id };
  }

  async sendMedia(
    target: string,
    media: { url: string; name?: string; mimeType?: string },
    caption?: string,
  ): Promise<PhotonSendResult> {
    const space = await this.resolveSpace(target);
    const input = /^https?:\/\//i.test(media.url) ? new URL(media.url) : media.url;
    const opts = {
      ...(media.name ? { name: media.name } : {}),
      ...(media.mimeType ? { mimeType: media.mimeType } : {}),
    };
    const result = await space.send(
      attachment(input, Object.keys(opts).length > 0 ? opts : undefined),
    );
    this.rememberSentMessageId(result?.id ?? null);
    // iMessage delivers the caption as a separate bubble; send it after the
    // media so the attachment renders first.
    if (caption?.trim()) {
      try {
        const captionResult = await space.send(markdown(caption));
        this.rememberSentMessageId(captionResult?.id ?? null);
      } catch (err) {
        // The attachment is already delivered; failing here would invite a
        // retry that sends it twice.
        console.warn(`photon: caption send failed after media delivery: ${String(err)}`);
      }
    }
    return { messageId: result?.id ?? null, spaceId: space.id };
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

function isBinaryContent(content: PhotonInboundContent): content is PhotonBinaryContent {
  return (
    (content.type === "attachment" || content.type === "voice") &&
    typeof (content as PhotonBinaryContent).read === "function"
  );
}

/**
 * Normalize inbound Spectrum content. Binary content is read eagerly because
 * Spectrum content objects may not outlive the stream iteration; oversize or
 * unreadable media degrades to a text marker instead of breaking the loop.
 */
export async function normalizePhotonContent(
  content: PhotonInboundContent,
  opts: { maxBytes: number; onReadError?: (err: unknown) => void },
): Promise<PhotonNormalizedContent | null> {
  if (content.type === "text") {
    return { text: (content as { text?: string }).text ?? "", attachments: [] };
  }
  if (content.type === "markdown") {
    return { text: (content as { markdown?: string }).markdown ?? "", attachments: [] };
  }
  if (content.type === "richlink") {
    return { text: (content as { url?: string }).url ?? "", attachments: [] };
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
    } catch (err) {
      opts.onReadError?.(err);
      return { text: "", attachments: [{ kind, placeholder }] };
    }
  }
  return null;
}

// Reads a Photon Beta event into what the channel needs from an inbound
// iMessage. Pure, so it is easy to test against recorded payloads.
import type { PhotonEvent } from "./events.js";

export type PhotonInboundEvent = {
  messageId: string;
  /** Sender handle: E.164 phone or iMessage email. */
  handle: string;
  spaceId: string;
  /** The line's User id; replies go out as this sender. */
  agentUserId: string;
  agentHandle?: string;
  direct: boolean;
  text: string;
  attachments: Array<{ attachmentId: string; kind: "attachment" | "voice" }>;
  /** Content types this plugin can't pass on, for a text marker. */
  unsupported: string[];
  timestamp: number;
};

type Party = { id?: unknown; handle?: unknown; kind?: unknown };
type Part = { type?: unknown; text?: unknown; attachmentId?: unknown };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * `message.received` from a person on iMessage, or null for every other event
 * (delivery receipts, the agent's own sends, other platforms).
 */
export function parsePhotonInbound(event: PhotonEvent): PhotonInboundEvent | null {
  if (event.type !== "message.received") {
    return null;
  }
  const message = (event.data?.object ?? {}) as {
    id?: unknown;
    platform?: unknown;
    sentBy?: Party;
    receivedBy?: Party;
    space?: { id?: unknown; kind?: unknown };
    content?: Part & { parts?: unknown };
    createdAt?: unknown;
  };
  const messageId = str(message.id);
  const handle = str(message.sentBy?.handle);
  const spaceId = str(message.space?.id);
  const agentUserId = str(message.receivedBy?.id);
  if (message.platform !== "imessage" || !messageId || !handle || !spaceId || !agentUserId) {
    return null;
  }
  if (message.sentBy?.kind !== "human") {
    return null;
  }

  const content = message.content ?? {};
  const parts: Part[] =
    content.type === "group" && Array.isArray(content.parts) ? (content.parts as Part[]) : [content];
  const texts: string[] = [];
  const attachments: PhotonInboundEvent["attachments"] = [];
  const unsupported: string[] = [];
  for (const part of parts) {
    const type = str(part.type) ?? "unknown";
    if (type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else if ((type === "attachment" || type === "voice") && str(part.attachmentId)) {
      attachments.push({ attachmentId: str(part.attachmentId) as string, kind: type });
    } else if (type === "message.read" || type === "space.typing.update") {
      // Read receipts and typing are state, not messages.
    } else {
      unsupported.push(type);
    }
  }

  const created = typeof message.createdAt === "string" ? Date.parse(message.createdAt) : NaN;
  return {
    messageId,
    handle,
    spaceId,
    agentUserId,
    agentHandle: str(message.receivedBy?.handle),
    direct: message.space?.kind === "direct",
    text: texts.join("\n"),
    attachments,
    unsupported,
    timestamp: Number.isFinite(created) ? created : Date.now(),
  };
}

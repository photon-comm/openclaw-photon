function str(value) {
    return typeof value === "string" && value ? value : undefined;
}
/**
 * `message.received` from a person on iMessage, or null for every other event
 * (delivery receipts, the agent's own sends, other platforms).
 */
export function parsePhotonInbound(event) {
    if (event.type !== "message.received") {
        return null;
    }
    const message = (event.data?.object ?? {});
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
    const parts = content.type === "group" && Array.isArray(content.parts) ? content.parts : [content];
    const texts = [];
    const attachments = [];
    const unsupported = [];
    for (const part of parts) {
        const type = str(part.type) ?? "unknown";
        if (type === "text" && typeof part.text === "string") {
            texts.push(part.text);
        }
        else if ((type === "attachment" || type === "voice") && str(part.attachmentId)) {
            attachments.push({ attachmentId: str(part.attachmentId), kind: type });
        }
        else if (type === "message.read" || type === "space.typing.update") {
            // Read receipts and typing are state, not messages.
        }
        else {
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

// Photon Beta (2.0) API for one project: https://api.photon.codes/v1, through
// the `@photon-ai/api` client and a project API key (`pho_sk_...`).
//
// Everything the gateway sends goes through here: text, attachments, typing,
// read receipts, plus the lookups that find the conversation (Space) and the
// line (agent User) for a handle. Plain request/response; the live event
// stream lives in events.ts.
import { randomUUID } from "node:crypto";
import { ApiError, Photon, PhotonError, ResponseValidationError } from "@photon-ai/api";
import { normalizePhotonHandle } from "./normalize.js";
import { photonApiOrigin } from "./origin.js";
export { photonApiOrigin };
/** One readable line for any Photon client error, with the request id when there is one. */
export function describePhotonError(err) {
    if (err instanceof ApiError) {
        const body = (err.body ?? {});
        const code = typeof body.code === "string" ? ` ${body.code}` : "";
        const detail = typeof body.detail === "string"
            ? `: ${body.detail}`
            : typeof body.error === "string"
                ? `: ${body.error}`
                : "";
        const request = err.requestId ? ` (request ${err.requestId})` : "";
        return `Photon ${err.status}${code}${detail}${request}`;
    }
    if (err instanceof ResponseValidationError) {
        return `Photon returned an unexpected response (HTTP ${err.status})`;
    }
    if (err instanceof PhotonError || err instanceof Error) {
        return err.message;
    }
    return String(err);
}
export function photonErrorCode(err) {
    if (!(err instanceof ApiError)) {
        return undefined;
    }
    const code = err.body?.code;
    return typeof code === "string" ? code : undefined;
}
export class PhotonProjectApi {
    projectId;
    apiKey;
    photon;
    origin;
    fetchImpl;
    constructor(projectId, apiKey, opts) {
        this.projectId = projectId;
        this.apiKey = apiKey;
        this.origin = opts?.origin ?? photonApiOrigin();
        this.fetchImpl = opts?.fetch ?? globalThis.fetch;
        this.photon = new Photon({
            baseUrl: this.origin,
            fetch: this.fetchImpl,
            headers: { Authorization: `Bearer ${apiKey}` },
        });
    }
    async getProject() {
        const project = await this.photon.projects.get({ path: { projectId: this.projectId } });
        return { projectId: project.projectId, name: project.name };
    }
    async sendText(conversation, text) {
        const message = await this.photon.projects.sendMessage({
            path: { id: this.projectId },
            headers: { "idempotency-key": `openclaw-text:${randomUUID()}` },
            body: {
                spaceId: conversation.spaceId,
                senderId: conversation.agentUserId,
                content: { type: "text", format: "plain", text },
            },
        });
        return { id: String(message.id) };
    }
    async sendFile(conversation, file) {
        const attachmentId = await this.upload(file);
        const message = await this.photon.projects.sendMessage({
            path: { id: this.projectId },
            headers: { "idempotency-key": `openclaw-file:${attachmentId}` },
            body: {
                spaceId: conversation.spaceId,
                senderId: conversation.agentUserId,
                content: { type: "attachment", attachmentId },
            },
        });
        return { id: String(message.id) };
    }
    /**
     * Upload bytes as a project attachment. The endpoint takes
     * `multipart/related`: a JSON part (contentType, sizeBytes, filename), then
     * the bytes. The generated client has no helper for it, so this is a plain
     * fetch. Returns the attachment id.
     */
    async upload(file) {
        const boundary = `openclaw-${randomUUID()}`;
        const meta = JSON.stringify({
            contentType: file.contentType,
            sizeBytes: file.buffer.length,
            filename: file.fileName,
        });
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n`),
            file.buffer,
            Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const response = await this.fetchImpl(`${this.origin}/v1/projects/${encodeURIComponent(this.projectId)}/attachments`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                // Photon refuses any parameter other than the boundary.
                "Content-Type": `multipart/related; boundary=${boundary}`,
                "Idempotency-Key": `openclaw-upload:${randomUUID()}`,
            },
            body,
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Photon attachment upload failed: HTTP ${response.status}: ${text.slice(0, 300)}`);
        }
        let id;
        try {
            id = JSON.parse(text).id;
        }
        catch {
            id = undefined;
        }
        if (typeof id !== "string" || !id) {
            throw new Error("Photon attachment upload returned no attachment id");
        }
        return id;
    }
    async downloadAttachment(attachmentId) {
        const path = { id: this.projectId, attachmentId };
        const meta = await this.photon.projects.getAttachment({ path });
        const blob = await this.photon.projects.downloadAttachment({ path });
        return {
            buffer: Buffer.from(await blob.arrayBuffer()),
            contentType: meta.contentType || blob.type || "application/octet-stream",
            fileName: meta.filename,
        };
    }
    async attachmentSize(attachmentId) {
        const meta = await this.photon.projects.getAttachment({
            path: { id: this.projectId, attachmentId },
        });
        return typeof meta.sizeBytes === "number" ? meta.sizeBytes : undefined;
    }
    async setTyping(conversation, typing) {
        await this.photon.projects.setSpaceTyping({
            path: { id: this.projectId, spaceId: conversation.spaceId },
            body: { senderId: conversation.agentUserId, typing },
        });
    }
    async markRead(messageId) {
        await this.photon.projects.markMessageRead({
            path: { id: this.projectId, messageId },
            headers: { "idempotency-key": `openclaw-read:${messageId}` },
        });
    }
    /** Shared-line assignments: which line each handle texts. */
    async listAssignments() {
        const out = [];
        let pageToken;
        do {
            const page = await this.photon.projects.platforms.imessage.assignments.list({
                path: { id: this.projectId },
                ...(pageToken ? { query: { pageToken } } : {}),
            });
            for (const assignment of page.assignments) {
                if (!assignment.releasedAt && assignment.platform === "imessage") {
                    out.push({ handle: assignment.handle, line: assignment.assignedPhoneNumber });
                }
            }
            pageToken = page.nextPageToken;
        } while (pageToken);
        return out;
    }
    /** Numbers of the project's own (dedicated) iMessage lines. */
    async listDedicatedLines() {
        const lines = [];
        let pageToken;
        do {
            const page = await this.photon.projects.platforms.listResources({
                path: { id: this.projectId },
                ...(pageToken ? { query: { pageToken } } : {}),
            });
            for (const resource of page.resources) {
                const phone = resource.detail.phoneNumber;
                if (resource.state === "active" &&
                    resource.abilities.includes("imessage") &&
                    typeof phone === "string" &&
                    phone) {
                    lines.push(phone);
                }
            }
            pageToken = page.nextPageToken;
        } while (pageToken);
        return lines;
    }
    async createOrGetUser(handle) {
        const user = await this.photon.projects.createOrGetUser({
            path: { id: this.projectId },
            body: { handle, platform: "imessage" },
        });
        return String(user.id);
    }
    async createOrGetSpace(agentUserId, peerUserId) {
        const space = await this.photon.projects.createOrGetSpace({
            path: { id: this.projectId },
            headers: { "idempotency-key": `openclaw-space:${agentUserId}:${peerUserId}` },
            // iMessage uses the first participant as the creator: the line.
            body: { platform: "imessage", participantIds: [agentUserId, peerUserId] },
        });
        return String(space.id);
    }
    /**
     * Find the DM with `handle`: its shared-line assignment names the line, or
     * else the project's dedicated line. A shared line can only answer someone
     * who has texted it; Photon refuses the send otherwise.
     */
    async resolveConversation(handle) {
        const peer = normalizePhotonHandle(handle);
        const assignment = (await this.listAssignments()).find((entry) => normalizePhotonHandle(entry.handle) === peer);
        const line = assignment?.line ?? (await this.listDedicatedLines())[0];
        if (!line) {
            throw new Error(`Photon project ${this.projectId} has no iMessage line for ${handle}: assign it a shared line or add a dedicated line in the dashboard.`);
        }
        const agentUserId = await this.createOrGetUser(line);
        const peerUserId = await this.createOrGetUser(peer);
        const spaceId = await this.createOrGetSpace(agentUserId, peerUserId);
        return { spaceId, agentUserId, agentHandle: line };
    }
}

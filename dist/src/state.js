// What the gateway keeps between restarts, per account, in OpenClaw's state
// directory: the event cursor, recently handled message ids (against
// redelivery) and the conversation found for each handle.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const MAX_SEEN = 1000;
const MAX_CONVERSATIONS = 2048;
export function photonStateFile(stateDir, accountId) {
    const safe = accountId.replace(/[^A-Za-z0-9_.-]/g, "_") || "default";
    return join(stateDir, "photon", `${safe}.json`);
}
export class PhotonStateStore {
    file;
    projectId;
    cursor = 0;
    seen = [];
    seenSet = new Set();
    conversations = new Map();
    constructor(file, projectId) {
        this.file = file;
        this.projectId = projectId;
        if (!file) {
            return;
        }
        let data = {};
        try {
            data = JSON.parse(readFileSync(file, "utf8"));
        }
        catch {
            data = {};
        }
        // A different project starts from scratch: its cursor means nothing here.
        if (data.projectId !== projectId) {
            return;
        }
        this.cursor = typeof data.cursor === "number" && data.cursor > 0 ? data.cursor : 0;
        for (const id of data.seen ?? []) {
            this.markSeen(id);
        }
        for (const [handle, conversation] of Object.entries(data.conversations ?? {})) {
            if (conversation?.spaceId && conversation.agentUserId) {
                this.conversations.set(handle, conversation);
            }
        }
    }
    getCursor() {
        return this.cursor;
    }
    setCursor(seq) {
        if (seq > this.cursor) {
            this.cursor = seq;
            this.save();
        }
    }
    hasSeen(id) {
        return this.seenSet.has(id);
    }
    /** Returns false when the id was already seen. */
    markSeen(id) {
        if (this.seenSet.has(id)) {
            return false;
        }
        this.seen.push(id);
        this.seenSet.add(id);
        while (this.seen.length > MAX_SEEN) {
            const oldest = this.seen.shift();
            if (oldest !== undefined) {
                this.seenSet.delete(oldest);
            }
        }
        return true;
    }
    getConversation(handle) {
        return this.conversations.get(handle);
    }
    setConversation(handle, conversation) {
        const current = this.conversations.get(handle);
        if (current?.spaceId === conversation.spaceId &&
            current.agentUserId === conversation.agentUserId &&
            current.agentHandle === conversation.agentHandle) {
            return;
        }
        this.conversations.delete(handle);
        this.conversations.set(handle, conversation);
        while (this.conversations.size > MAX_CONVERSATIONS) {
            const oldest = this.conversations.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.conversations.delete(oldest);
        }
        this.save();
    }
    forgetConversation(handle) {
        if (this.conversations.delete(handle)) {
            this.save();
        }
    }
    save() {
        if (!this.file) {
            return;
        }
        const data = {
            projectId: this.projectId,
            cursor: this.cursor,
            seen: this.seen,
            conversations: Object.fromEntries(this.conversations),
        };
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        // Write and rename, so a crash never leaves half a file.
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
        renameSync(tmp, this.file);
    }
}
/**
 * Events are handled concurrently (one conversation must not wait for
 * another's agent turn), but the cursor may only move past an event once it
 * and every event before it are done. Returns the new cursor, if it moved.
 */
export class CursorTracker {
    pending = [];
    done = new Set();
    start(seq) {
        this.pending.push(seq);
    }
    finish(seq) {
        this.done.add(seq);
        let advanced;
        while (this.pending.length > 0 && this.done.has(this.pending[0])) {
            advanced = this.pending.shift();
            if (advanced !== undefined) {
                this.done.delete(advanced);
            }
        }
        return advanced;
    }
}

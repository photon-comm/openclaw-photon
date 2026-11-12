// What the gateway keeps between restarts, per account, in OpenClaw's state
// directory: the event cursor, recently handled message ids (against
// redelivery) and the conversation found for each handle.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PhotonConversation } from "./api.js";

const MAX_SEEN = 1000;
const MAX_CONVERSATIONS = 2048;

type PersistedState = {
  projectId?: string;
  cursor?: number;
  seen?: string[];
  conversations?: Record<string, PhotonConversation>;
};

export function photonStateFile(stateDir: string, accountId: string): string {
  const safe = accountId.replace(/[^A-Za-z0-9_.-]/g, "_") || "default";
  return join(stateDir, "photon", `${safe}.json`);
}

export class PhotonStateStore {
  private cursor = 0;
  private readonly seen: string[] = [];
  private readonly seenSet = new Set<string>();
  private readonly conversations = new Map<string, PhotonConversation>();

  constructor(
    private readonly file: string | undefined,
    private readonly projectId: string,
    /** Called when the file can't be written; the gateway keeps running. */
    private readonly onError?: (err: unknown) => void,
  ) {
    if (!file) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      parsed = undefined;
    }
    // A missing, unreadable or hand-edited file starts from scratch.
    const data: PersistedState =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PersistedState) : {};
    // A different project starts from scratch: its cursor means nothing here.
    if (data.projectId !== projectId) {
      return;
    }
    this.cursor = typeof data.cursor === "number" && data.cursor > 0 ? data.cursor : 0;
    for (const id of Array.isArray(data.seen) ? data.seen : []) {
      if (typeof id === "string") {
        this.markSeen(id);
      }
    }
    const conversations =
      data.conversations && typeof data.conversations === "object" ? data.conversations : {};
    for (const [handle, conversation] of Object.entries(conversations)) {
      if (
        conversation &&
        typeof conversation.spaceId === "string" &&
        typeof conversation.agentUserId === "string"
      ) {
        this.conversations.set(handle, conversation);
      }
    }
  }

  getCursor(): number {
    return this.cursor;
  }

  setCursor(seq: number): void {
    if (seq > this.cursor) {
      this.cursor = seq;
      this.save();
    }
  }

  hasSeen(id: string): boolean {
    return this.seenSet.has(id);
  }

  /** Returns false when the id was already seen. */
  markSeen(id: string): boolean {
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

  getConversation(handle: string): PhotonConversation | undefined {
    return this.conversations.get(handle);
  }

  setConversation(handle: string, conversation: PhotonConversation): void {
    const current = this.conversations.get(handle);
    if (
      current?.spaceId === conversation.spaceId &&
      current.agentUserId === conversation.agentUserId &&
      current.agentHandle === conversation.agentHandle
    ) {
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

  forgetConversation(handle: string): void {
    if (this.conversations.delete(handle)) {
      this.save();
    }
  }

  /** Writes the state file. Never throws: a failed write is reported and retried on the next save. */
  save(): void {
    if (!this.file) {
      return;
    }
    const data: PersistedState = {
      projectId: this.projectId,
      cursor: this.cursor,
      seen: this.seen,
      conversations: Object.fromEntries(this.conversations),
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      // Write and rename, so a crash never leaves half a file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.onError?.(err);
    }
  }
}

/**
 * Events are handled concurrently (one conversation must not wait for
 * another's agent turn), but the cursor may only move past an event once it
 * and every event before it are done. Returns the new cursor, if it moved.
 */
export class CursorTracker {
  private readonly pending: number[] = [];
  private readonly done = new Set<number>();

  /** `committed` is the cursor already saved; nothing at or below it is tracked again. */
  constructor(private committed = 0) {}

  /**
   * Track a delivery. Returns false for a replay of a sequence that is
   * already tracked or already committed: finishing it is the original's job.
   */
  start(seq: number): boolean {
    if (seq <= this.committed || this.pending.includes(seq)) {
      return false;
    }
    this.pending.push(seq);
    return true;
  }

  finish(seq: number): number | undefined {
    if (!this.pending.includes(seq)) {
      return undefined;
    }
    this.done.add(seq);
    let advanced: number | undefined;
    while (this.pending.length > 0 && this.done.has(this.pending[0])) {
      advanced = this.pending.shift();
      if (advanced !== undefined) {
        this.done.delete(advanced);
      }
    }
    if (advanced !== undefined) {
      this.committed = advanced;
    }
    return advanced;
  }
}

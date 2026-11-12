// Photon tests cover the cursor and conversation state kept across restarts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CursorTracker, PhotonStateStore, photonStateFile } from "./state.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "photon-state-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PhotonStateStore", () => {
  it("keeps the cursor, seen ids and conversations across instances", () => {
    const file = photonStateFile(tempDir(), "default");
    const first = new PhotonStateStore(file, "pho_prj_1");
    first.setConversation("+15551234567", { spaceId: "s1", agentUserId: "u1", agentHandle: "+1555" });
    first.markSeen("pho_msg_1");
    first.setCursor(42);

    const second = new PhotonStateStore(file, "pho_prj_1");
    expect(second.getCursor()).toBe(42);
    expect(second.hasSeen("pho_msg_1")).toBe(true);
    expect(second.getConversation("+15551234567")).toEqual({
      spaceId: "s1",
      agentUserId: "u1",
      agentHandle: "+1555",
    });
    expect(JSON.parse(readFileSync(file, "utf8")).projectId).toBe("pho_prj_1");
  });

  it("starts over for a different project", () => {
    const file = photonStateFile(tempDir(), "default");
    new PhotonStateStore(file, "pho_prj_1").setCursor(7);
    expect(new PhotonStateStore(file, "pho_prj_2").getCursor()).toBe(0);
  });

  it("starts over from a corrupt or hand-edited file", () => {
    const file = join(tempDir(), "default.json");
    for (const content of ["null", "[]", '{"projectId":"p","seen":{},"conversations":null,"cursor":"x"}']) {
      writeFileSync(file, content);
      const store = new PhotonStateStore(file, "p");
      expect(store.getCursor()).toBe(0);
      expect(store.hasSeen("x")).toBe(false);
    }
  });

  it("reports a state file it can't write instead of throwing", () => {
    const errors: unknown[] = [];
    // A regular file where the state directory should be: mkdir fails with ENOTDIR.
    const blocker = join(tempDir(), "not-a-dir");
    writeFileSync(blocker, "");
    const store = new PhotonStateStore(join(blocker, "photon", "default.json"), "p", (err) => errors.push(err));
    expect(() => store.setCursor(5)).not.toThrow();
    expect(store.getCursor()).toBe(5);
    expect(errors).toHaveLength(1);
  });

  it("never moves the cursor back", () => {
    const store = new PhotonStateStore(undefined, "p");
    store.setCursor(10);
    store.setCursor(3);
    expect(store.getCursor()).toBe(10);
  });
});

describe("CursorTracker", () => {
  it("advances only past events that finished in order", () => {
    const tracker = new CursorTracker();
    tracker.start(5);
    tracker.start(9);
    tracker.start(12);
    expect(tracker.finish(9)).toBeUndefined();
    expect(tracker.finish(5)).toBe(9);
    expect(tracker.finish(12)).toBe(12);
  });

  it("ignores a replay of a sequence that is still running or already committed", () => {
    const tracker = new CursorTracker(4);
    expect(tracker.start(4)).toBe(false);
    expect(tracker.start(5)).toBe(true);
    expect(tracker.start(5)).toBe(false);
    expect(tracker.start(6)).toBe(true);
    expect(tracker.finish(6)).toBeUndefined();
    expect(tracker.finish(5)).toBe(6);
    expect(tracker.start(6)).toBe(false);
    expect(tracker.finish(6)).toBeUndefined();
  });
});

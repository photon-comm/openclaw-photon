// Photon tests cover the cursor and conversation state kept across restarts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});

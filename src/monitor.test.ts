// Photon tests run fake events through the gateway: a sender who isn't let
// in must not make it download or save anything.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({
  onEvent: undefined as undefined | ((event: unknown, meta: { seq?: number }) => void),
}));
const stateDir = vi.hoisted(() => ({ path: "" }));

vi.mock("./events.js", () => ({
  subscribePhotonEvents: (opts: { onEvent: (event: unknown, meta: { seq?: number }) => void }) => {
    events.onEvent = opts.onEvent;
    return { stop: () => {}, isSubscribed: () => true };
  },
}));
vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => stateDir.path,
}));
vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaBuffer: vi.fn(
    async (_buffer: Buffer, contentType: string, _subdir: string, _maxBytes: number, fileName?: string) => ({
      path: `/state/media/inbound/${fileName ?? "file"}`,
      contentType,
    }),
  ),
}));

import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { PhotonProjectApi } from "./api.js";
import { monitorPhotonProvider } from "./monitor.js";
import { setPhotonRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const OWNER = "+15551234567";
const STRANGER = "+15559876543";
const LINE_USER = "pho_usr_line";

let previousStateDir: string | undefined;

beforeAll(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterAll(() => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

function fakeRuntime() {
  const dispatchReply = vi.fn(async (_params: { ctxPayload: Record<string, unknown> }) => ({}));
  const upsertPairingRequest = vi.fn(async () => ({ code: "PAIR1234", created: true }));
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const core = {
    channel: {
      pairing: { readAllowFromStore: vi.fn(async () => []), upsertPairingRequest },
      commands: { shouldHandleTextCommands: () => true },
      text: { hasControlCommand: () => false },
      routing: {
        resolveAgentRoute: (params: { accountId: string; peer: { id: string } }) => ({
          agentId: "main",
          accountId: params.accountId,
          sessionKey: `agent:main:photon:direct:${params.peer.id}`,
        }),
      },
      inbound: { dispatchReply },
      session: { recordInboundSession: vi.fn() },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
      activity: { record: vi.fn() },
    },
    logging: { getChildLogger: () => logger, shouldLogVerbose: () => false },
  };
  setPhotonRuntime(core as unknown as PluginRuntime);
  return { dispatchReply, upsertPairingRequest };
}

function config(photon: Record<string, unknown>): CoreConfig {
  return {
    channels: { photon: { projectId: "pho_prj_test", apiKey: "pho_sk_test", ...photon } },
  } as CoreConfig;
}

let seq = 0;

function received(params: {
  id: string;
  from: string;
  text?: string;
  attachments?: string[];
  space?: "direct" | "group";
}) {
  const parts = [
    ...(params.text ? [{ type: "text", text: params.text }] : []),
    ...(params.attachments ?? []).map((attachmentId) => ({ type: "attachment", attachmentId })),
  ];
  return {
    type: "message.received",
    data: {
      object: {
        id: params.id,
        platform: "imessage",
        sentBy: { id: `pho_usr_${params.from}`, handle: params.from, kind: "human" },
        receivedBy: { id: LINE_USER, handle: "+15550000001", kind: "agent" },
        space: { id: `pho_spc_${params.from}`, kind: params.space ?? "direct" },
        content: { type: "group", parts },
        createdAt: "2026-11-15T00:00:00.000Z",
      },
    },
  };
}

function stateFile() {
  return join(stateDir.path, "photon", "default.json");
}

function savedState(): { seen?: string[]; conversations?: Record<string, { spaceId: string }> } {
  return existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), "utf8")) : {};
}

/** Deliver one event and wait until the gateway has finished with it. */
async function deliver(event: ReturnType<typeof received>) {
  seq += 1;
  events.onEvent?.(event, { seq });
  await vi.waitFor(() => expect(savedState().seen ?? []).toContain(event.data.object.id));
}

describe("monitorPhotonProvider: attachments wait for the sender check", () => {
  let api: {
    attachmentSize: ReturnType<typeof vi.fn>;
    downloadAttachment: ReturnType<typeof vi.fn>;
    sendText: ReturnType<typeof vi.fn>;
  };
  let stop: (() => void) | undefined;

  beforeEach(() => {
    stateDir.path = mkdtempSync(join(tmpdir(), "photon-monitor-test-"));
    process.env.OPENCLAW_STATE_DIR = stateDir.path;
    seq = 0;
    vi.mocked(saveMediaBuffer).mockClear();
    vi.spyOn(PhotonProjectApi.prototype, "getProject").mockResolvedValue({
      projectId: "pho_prj_test",
      name: "Test",
    });
    vi.spyOn(PhotonProjectApi.prototype, "markRead").mockResolvedValue(undefined);
    vi.spyOn(PhotonProjectApi.prototype, "setTyping").mockResolvedValue(undefined);
    api = {
      attachmentSize: vi.spyOn(PhotonProjectApi.prototype, "attachmentSize").mockResolvedValue(3),
      downloadAttachment: vi.spyOn(PhotonProjectApi.prototype, "downloadAttachment").mockResolvedValue({
        buffer: Buffer.from("png"),
        contentType: "image/png",
        fileName: "cat.png",
      }),
      sendText: vi.spyOn(PhotonProjectApi.prototype, "sendText").mockResolvedValue({ id: "pho_msg_out" }),
    } as never;
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.restoreAllMocks();
    rmSync(stateDir.path, { recursive: true, force: true });
  });

  async function start(cfg: CoreConfig) {
    const handle = await monitorPhotonProvider({
      config: cfg,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as never,
    });
    stop = handle.stop;
  }

  it("a sender outside allowFrom: no attachment lookup, no download, no saved file, no remembered conversation", async () => {
    const { dispatchReply } = fakeRuntime();
    await start(config({ dmPolicy: "allowlist", allowFrom: [OWNER] }));

    await deliver(
      received({ id: "pho_msg_1", from: STRANGER, text: "hi", attachments: ["pho_att_1", "pho_att_2"] }),
    );

    expect(api.attachmentSize).not.toHaveBeenCalled();
    expect(api.downloadAttachment).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
    expect(api.sendText).not.toHaveBeenCalled();
    expect(savedState().conversations?.[STRANGER]).toBeUndefined();
  });

  it("an allowed sender: the attachment is downloaded and saved as before, then the agent gets it", async () => {
    const { dispatchReply } = fakeRuntime();
    await start(config({ dmPolicy: "allowlist", allowFrom: [OWNER] }));

    await deliver(received({ id: "pho_msg_2", from: OWNER, text: "look", attachments: ["pho_att_3"] }));

    expect(api.attachmentSize).toHaveBeenCalledWith("pho_att_3");
    expect(api.downloadAttachment).toHaveBeenCalledWith("pho_att_3");
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("png"),
      "image/png",
      "inbound",
      20 * 1024 * 1024,
      "cat.png",
    );
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    const ctx = dispatchReply.mock.calls[0]?.[0].ctxPayload ?? {};
    expect(ctx.RawBody).toBe("look");
    expect(ctx.media).toEqual([expect.objectContaining({ path: "/state/media/inbound/cat.png" })]);
    expect(savedState().conversations?.[OWNER]).toMatchObject({ spaceId: `pho_spc_${OWNER}` });
  });

  it("an allowed sender: an attachment over mediaMaxMb becomes a marker without a download", async () => {
    const { dispatchReply } = fakeRuntime();
    api.attachmentSize.mockResolvedValue(2 * 1024 * 1024);
    await start(config({ dmPolicy: "allowlist", allowFrom: [OWNER], mediaMaxMb: 1 }));

    await deliver(received({ id: "pho_msg_3", from: OWNER, attachments: ["pho_att_4"] }));

    expect(api.downloadAttachment).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(dispatchReply.mock.calls[0]?.[0].ctxPayload.RawBody).toBe(
      "[Photon attachment received: too large to read (2097152 bytes)]",
    );
  });

  it("an allowed sender: a download that fails becomes a marker, and the turn still runs", async () => {
    const { dispatchReply } = fakeRuntime();
    api.downloadAttachment.mockRejectedValue(new Error("connection reset"));
    await start(config({ dmPolicy: "allowlist", allowFrom: [OWNER] }));

    await deliver(received({ id: "pho_msg_6", from: OWNER, text: "look", attachments: ["pho_att_7"] }));

    expect(api.downloadAttachment).toHaveBeenCalledWith("pho_att_7");
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    const ctx = dispatchReply.mock.calls[0]?.[0].ctxPayload ?? {};
    expect(ctx.RawBody).toBe("look\n[Photon attachment received: pho_att_7]");
    expect(ctx.media).toEqual([]);
  });

  it("a group message: dropped before anything is fetched, even from an allowed sender", async () => {
    const { dispatchReply } = fakeRuntime();
    await start(config({ dmPolicy: "allowlist", allowFrom: [OWNER] }));

    await deliver(received({ id: "pho_msg_4", from: OWNER, text: "hi all", attachments: ["pho_att_5"], space: "group" }));

    expect(api.attachmentSize).not.toHaveBeenCalled();
    expect(api.downloadAttachment).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
    expect(savedState().conversations?.[OWNER]).toBeUndefined();
  });

  it("pairing: an unknown sender gets the code in the conversation they wrote from, and their attachment stays on Photon", async () => {
    const { dispatchReply, upsertPairingRequest } = fakeRuntime();
    await start(config({ dmPolicy: "pairing" }));

    await deliver(received({ id: "pho_msg_5", from: STRANGER, text: "hi", attachments: ["pho_att_6"] }));

    expect(upsertPairingRequest).toHaveBeenCalledTimes(1);
    expect(api.sendText).toHaveBeenCalledTimes(1);
    expect(api.sendText.mock.calls[0]?.[0]).toEqual({
      spaceId: `pho_spc_${STRANGER}`,
      agentUserId: LINE_USER,
      agentHandle: "+15550000001",
    });
    expect(String(api.sendText.mock.calls[0]?.[1])).toContain("PAIR1234");
    // Saved because the code went out; a sender who gets nothing isn't saved.
    expect(savedState().conversations?.[STRANGER]).toMatchObject({ spaceId: `pho_spc_${STRANGER}` });
    expect(api.attachmentSize).not.toHaveBeenCalled();
    expect(api.downloadAttachment).not.toHaveBeenCalled();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });
});

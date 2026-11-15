// Photon tests cover who reaches the agent, and that nothing is fetched,
// saved or remembered for a sender who doesn't.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePhotonInbound } from "./inbound.js";
import type { PhotonInboundAttachment } from "./message.js";
import { setPhotonRuntime } from "./runtime.js";
import {
  resolvePhotonAccount,
  type CoreConfig,
  type PhotonInboundMessage,
  type PhotonStagedAttachments,
} from "./types.js";

const OWNER = "+15551234567";
const STRANGER = "+15559876543";

let stateDir: string;
let previousStateDir: string | undefined;

beforeAll(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "photon-inbound-test-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterAll(() => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

function fakeRuntime(opts: { pairingStore?: string[]; pairingCreated?: boolean } = {}) {
  const readAllowFromStore = vi.fn(async () => opts.pairingStore ?? []);
  const upsertPairingRequest = vi.fn(async (_request: { id: string; channel: string }) => ({
    code: "PAIR1234",
    created: opts.pairingCreated ?? true,
  }));
  const dispatchReply = vi.fn(async (_params: { ctxPayload: Record<string, unknown> }) => ({}));
  const core = {
    channel: {
      pairing: { readAllowFromStore, upsertPairingRequest },
      commands: { shouldHandleTextCommands: () => true },
      text: { hasControlCommand: (body: string) => /^\/status$/i.test(body.trim()) },
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
    },
  };
  setPhotonRuntime(core as unknown as PluginRuntime);
  return { readAllowFromStore, upsertPairingRequest, dispatchReply };
}

function configWith(dmPolicy: DmPolicy | undefined, allowFrom?: string[]): CoreConfig {
  return {
    channels: {
      photon: {
        projectId: "pho_prj_test",
        apiKey: "pho_sk_test",
        ...(dmPolicy ? { dmPolicy } : {}),
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as CoreConfig;
}

const ATTACHMENTS: PhotonInboundAttachment[] = [
  { attachmentId: "pho_att_1", kind: "attachment" },
  { attachmentId: "pho_att_2", kind: "voice" },
];

function message(overrides: Partial<PhotonInboundMessage> = {}): PhotonInboundMessage {
  return {
    messageId: "pho_msg_1",
    senderId: STRANGER,
    text: "hello",
    attachments: ATTACHMENTS,
    unsupported: [],
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

async function run(params: {
  config: CoreConfig;
  message: PhotonInboundMessage;
  staged?: PhotonStagedAttachments;
}) {
  const stageAttachments = vi.fn(
    async (_attachments: PhotonInboundAttachment[]): Promise<PhotonStagedAttachments> =>
      params.staged ?? { media: [{ path: "/state/media/inbound/a.png", contentType: "image/png" }], placeholders: [] },
  );
  const rememberConversation = vi.fn();
  const sendMessage = vi.fn(async (_to: string, _text: string, _opts?: unknown) => ({}) as never);
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  await handlePhotonInbound({
    message: params.message,
    account: resolvePhotonAccount({ cfg: params.config }),
    config: params.config,
    runtime: runtime as never,
    stageAttachments,
    rememberConversation,
    deps: { sendMessage },
  });
  return { stageAttachments, rememberConversation, sendMessage, runtime };
}

describe("handlePhotonInbound: a sender who isn't let in costs nothing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allowlist: a sender outside allowFrom gets no download, no saved file and no remembered conversation", async () => {
    const { dispatchReply } = fakeRuntime();
    const result = await run({ config: configWith("allowlist", [OWNER]), message: message() });

    expect(result.stageAttachments).not.toHaveBeenCalled();
    expect(result.rememberConversation).not.toHaveBeenCalled();
    expect(result.sendMessage).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
    expect(result.runtime.log).toHaveBeenCalledWith(`photon: drop DM sender ${STRANGER} (dmPolicy=allowlist)`);
  });

  it("allowlist: an attachment-only message from a blocked sender is dropped without a download", async () => {
    const { dispatchReply } = fakeRuntime();
    const result = await run({
      config: configWith("allowlist", [OWNER]),
      message: message({ text: "", attachments: [ATTACHMENTS[0]] }),
    });

    expect(result.stageAttachments).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("disabled: nobody gets through, not even a sender in allowFrom", async () => {
    const { dispatchReply } = fakeRuntime();
    const result = await run({
      config: configWith("disabled", [OWNER]),
      message: message({ senderId: OWNER }),
    });

    expect(result.stageAttachments).not.toHaveBeenCalled();
    expect(result.rememberConversation).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("open without a wildcard: a sender outside allowFrom is dropped", async () => {
    const { dispatchReply } = fakeRuntime();
    const result = await run({ config: configWith("open", [OWNER]), message: message() });

    expect(result.stageAttachments).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("pairing: an unknown sender gets one pairing code, and nothing is downloaded", async () => {
    const { dispatchReply, upsertPairingRequest } = fakeRuntime();
    // pairing is the default when dmPolicy is unset
    const result = await run({ config: configWith(undefined), message: message() });

    expect(upsertPairingRequest).toHaveBeenCalledTimes(1);
    expect(upsertPairingRequest.mock.calls[0]?.[0]).toMatchObject({ id: STRANGER, channel: "photon" });
    expect(result.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.sendMessage.mock.calls[0]?.[0]).toBe(STRANGER);
    expect(String(result.sendMessage.mock.calls[0]?.[1])).toContain("PAIR1234");
    // The pairing code goes back the way the message came in.
    expect(result.rememberConversation).toHaveBeenCalledTimes(1);
    expect(result.rememberConversation.mock.invocationCallOrder[0]).toBeLessThan(
      result.sendMessage.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result.stageAttachments).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("pairing: another message from a sender whose code is pending sends nothing and remembers nothing", async () => {
    const { dispatchReply } = fakeRuntime({ pairingCreated: false });
    const result = await run({ config: configWith("pairing"), message: message() });

    expect(result.sendMessage).not.toHaveBeenCalled();
    expect(result.rememberConversation).not.toHaveBeenCalled();
    expect(result.stageAttachments).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("an empty message does nothing at all", async () => {
    const { readAllowFromStore, dispatchReply } = fakeRuntime();
    const result = await run({
      config: configWith("open", ["*"]),
      message: message({ text: "   ", attachments: [] }),
    });

    expect(readAllowFromStore).not.toHaveBeenCalled();
    expect(result.stageAttachments).not.toHaveBeenCalled();
    expect(result.rememberConversation).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });
});

// The first dispatch loads OpenClaw's session store, which can take a few
// seconds on a cold CI runner.
describe("handlePhotonInbound: a sender who is let in gets the same turn as before", { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allowlist: attachments are staged after the check and reach the agent with the text and markers", async () => {
    const { dispatchReply } = fakeRuntime();
    const result = await run({
      config: configWith("allowlist", [OWNER]),
      message: message({ senderId: OWNER, unsupported: ["location"] }),
      staged: {
        media: [{ path: "/state/media/inbound/a.png", contentType: "image/png" }],
        placeholders: ["[Photon voice note received: pho_att_2]"],
      },
    });

    expect(result.stageAttachments).toHaveBeenCalledTimes(1);
    expect(result.stageAttachments).toHaveBeenCalledWith(ATTACHMENTS);
    expect(result.rememberConversation).toHaveBeenCalledTimes(1);
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    // The conversation is known and the attachments are saved before the
    // agent's turn starts (read receipt, typing and replies use them).
    expect(result.rememberConversation.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchReply.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result.stageAttachments.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchReply.mock.invocationCallOrder[0] ?? 0,
    );

    const ctx = dispatchReply.mock.calls[0]?.[0].ctxPayload ?? {};
    expect(ctx.RawBody).toBe(
      "hello\n[Photon voice note received: pho_att_2]\n[Photon message of type location received]",
    );
    expect(ctx.media).toEqual([
      expect.objectContaining({ path: "/state/media/inbound/a.png", contentType: "image/png" }),
    ]);
    expect(result.sendMessage).not.toHaveBeenCalled();
  });

  it("allowlist: entries match a formatted phone number and an email in another case", async () => {
    const { dispatchReply } = fakeRuntime();
    const config = configWith("allowlist", ["+1 (555) 987-6543", "me@icloud.com"]);

    const phone = await run({ config, message: message() });
    const email = await run({ config, message: message({ senderId: "Me@iCloud.com" }) });

    expect(phone.stageAttachments).toHaveBeenCalledTimes(1);
    expect(email.stageAttachments).toHaveBeenCalledTimes(1);
    expect(dispatchReply).toHaveBeenCalledTimes(2);
  });

  it("open with a wildcard: anyone gets through", async () => {
    const { dispatchReply } = fakeRuntime();
    const result = await run({ config: configWith("open", ["*"]), message: message() });

    expect(result.stageAttachments).toHaveBeenCalledTimes(1);
    expect(dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("pairing: a sender approved through pairing gets through without a new code", async () => {
    const { dispatchReply, readAllowFromStore, upsertPairingRequest } = fakeRuntime({
      pairingStore: [STRANGER],
    });
    const result = await run({ config: configWith("pairing"), message: message() });

    expect(upsertPairingRequest).not.toHaveBeenCalled();
    expect(result.sendMessage).not.toHaveBeenCalled();
    expect(result.stageAttachments).toHaveBeenCalledTimes(1);
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    // The approval is read before any attachment is fetched.
    expect(readAllowFromStore.mock.invocationCallOrder[0]).toBeLessThan(
      result.stageAttachments.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("pairing: an approval for one sender doesn't let another in", async () => {
    const { dispatchReply } = fakeRuntime({ pairingStore: [OWNER] });
    const result = await run({ config: configWith("pairing"), message: message() });

    expect(result.stageAttachments).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("a text-only message doesn't ask for attachments", async () => {
    const { dispatchReply } = fakeRuntime();
    const result = await run({
      config: configWith("allowlist", [OWNER]),
      message: message({ senderId: OWNER, attachments: [] }),
    });

    expect(result.stageAttachments).not.toHaveBeenCalled();
    expect(result.rememberConversation).toHaveBeenCalledTimes(1);
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(dispatchReply.mock.calls[0]?.[0].ctxPayload.RawBody).toBe("hello");
  });
});

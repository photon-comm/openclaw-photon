// Photon tests cover send behavior.
import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({
  loadOutboundMediaFromUrl: vi.fn(async () => ({
    buffer: Buffer.from("png-bytes"),
    contentType: "image/png",
  })),
}));

import { clearActivePhotonClient, setActivePhotonClient, type PhotonClient } from "./client.js";
import { preparePhotonText, sendMessagePhoton } from "./send.js";
import type { CoreConfig } from "./types.js";

const cfg = {
  channels: {
    photon: {
      projectId: "pho_prj_test",
      apiKey: "pho_sk_test",
    },
  },
} as CoreConfig;

function installFakeClient() {
  const sendText = vi.fn(async () => ({ messageId: "m-1", spaceId: "space-1" }));
  const sendFile = vi.fn(async () => ({ messageId: "m-2", spaceId: "space-1" }));
  const fake = { sendText, sendFile } as unknown as PhotonClient;
  setActivePhotonClient("default", fake);
  return { fake, sendText, sendFile };
}

describe("sendMessagePhoton", () => {
  it("sends text through the active client", async () => {
    const { fake, sendText } = installFakeClient();
    const result = await sendMessagePhoton("photon:+15551234567", "hello", { cfg });

    expect(sendText).toHaveBeenCalledWith("+15551234567", "hello");
    expect(result.messageId).toBe("m-1");
    expect(result.conversationId).toBe("space-1");
    expect(result.target).toEqual({ kind: "chat", id: "+15551234567" });
    expect(result.receipt.platformMessageIds).toEqual(["m-1"]);
    expect(result.receipt.parts[0]).toMatchObject({ platformMessageId: "m-1", kind: "text" });
    clearActivePhotonClient("default", fake);
  });

  it("sends to an iMessage email", async () => {
    const { fake, sendText } = installFakeClient();
    await sendMessagePhoton("photon:Me@iCloud.com", "hi", { cfg });
    expect(sendText).toHaveBeenCalledWith("me@icloud.com", "hi");
    clearActivePhotonClient("default", fake);
  });

  it("sends media first, then the caption as its own bubble", async () => {
    const { fake, sendText, sendFile } = installFakeClient();
    const result = await sendMessagePhoton("+15551234567", "caption", {
      cfg,
      mediaUrl: "https://example.com/cat.png",
    });

    expect(sendFile).toHaveBeenCalledWith("+15551234567", {
      buffer: Buffer.from("png-bytes"),
      contentType: "image/png",
      fileName: "cat.png",
    });
    expect(sendText).toHaveBeenCalledWith("+15551234567", "caption");
    expect(sendFile.mock.invocationCallOrder[0]).toBeLessThan(sendText.mock.invocationCallOrder[0]);
    expect(result.messageId).toBe("m-2");
    clearActivePhotonClient("default", fake);
  });

  it("rejects unconfigured accounts", async () => {
    await expect(
      sendMessagePhoton("+15551234567", "hello", { cfg: { channels: {} } as CoreConfig }),
    ).rejects.toThrow(/not configured/);
  });

  it("rejects targets that are not a phone or email", async () => {
    const { fake } = installFakeClient();
    await expect(sendMessagePhoton("pho_spc_123", "hello", { cfg })).rejects.toThrow(/Invalid Photon target/);
    clearActivePhotonClient("default", fake);
  });

  it("rejects empty payloads", async () => {
    const { fake } = installFakeClient();
    await expect(sendMessagePhoton("+15551234567", "   ", { cfg })).rejects.toThrow(/text or media/);
    clearActivePhotonClient("default", fake);
  });
});

describe("preparePhotonText", () => {
  it("flattens Markdown to plain text", () => {
    const out = preparePhotonText("**Paris** is the _capital_ of `France`.", cfg, "default");
    expect(out).toBe("Paris is the capital of France.");
  });
});

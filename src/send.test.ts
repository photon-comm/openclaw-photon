// Photon tests cover send behavior.
import { describe, expect, it, vi } from "vitest";
import { clearActivePhotonClient, setActivePhotonClient, type PhotonClient } from "./client.js";
import { sendMessagePhoton } from "./send.js";
import type { CoreConfig } from "./types.js";

const cfg = {
  channels: {
    photon: {
      projectId: "proj-123",
      projectSecret: "secret",
    },
  },
} as CoreConfig;

function installFakeClient() {
  const sendText = vi.fn(async () => ({ messageId: "m-1", spaceId: "space-1" }));
  const sendMedia = vi.fn(async () => ({ messageId: "m-2", spaceId: "space-1" }));
  const fake = { sendText, sendMedia } as unknown as PhotonClient;
  setActivePhotonClient("default", fake);
  return { fake, sendText, sendMedia };
}

describe("sendMessagePhoton", () => {
  it("sends text through the active client", async () => {
    const { fake, sendText } = installFakeClient();
    const result = await sendMessagePhoton("photon:+15551234567", "hello", { cfg });

    expect(sendText).toHaveBeenCalledWith("+15551234567", "hello");
    expect(result.messageId).toBe("m-1");
    expect(result.target).toEqual({ kind: "chat", id: "+15551234567" });
    expect(result.receipt.platformMessageIds).toEqual(["m-1"]);
    expect(result.receipt.parts[0]).toMatchObject({
      platformMessageId: "m-1",
      kind: "text",
    });
    clearActivePhotonClient("default", fake);
  });

  it("sends media with the text as caption", async () => {
    const { fake, sendMedia } = installFakeClient();
    const result = await sendMessagePhoton("+15551234567", "caption", {
      cfg,
      mediaUrl: "https://example.com/cat.png",
    });

    expect(sendMedia).toHaveBeenCalledWith(
      "+15551234567",
      { url: "https://example.com/cat.png" },
      "caption",
    );
    expect(result.messageId).toBe("m-2");
    clearActivePhotonClient("default", fake);
  });

  it("rejects unconfigured accounts", async () => {
    await expect(
      sendMessagePhoton("+15551234567", "hello", { cfg: { channels: {} } as CoreConfig }),
    ).rejects.toThrow(/not configured/);
  });

  it("rejects empty payloads", async () => {
    const { fake } = installFakeClient();
    await expect(sendMessagePhoton("+15551234567", "   ", { cfg })).rejects.toThrow(
      /text or media/,
    );
    clearActivePhotonClient("default", fake);
  });
});

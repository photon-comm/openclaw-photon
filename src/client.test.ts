// Photon tests cover inbound content normalization behavior.
import { describe, expect, it, vi } from "vitest";
import { normalizePhotonContent, readPhotonReactionContent } from "./client.js";

const MAX = 1024;

describe("normalizePhotonContent", () => {
  it("normalizes text and markdown content", async () => {
    expect(await normalizePhotonContent({ type: "text", text: "hi" }, { maxBytes: MAX })).toEqual({
      text: "hi",
      attachments: [],
    });
    expect(
      await normalizePhotonContent({ type: "markdown", markdown: "**hi**" }, { maxBytes: MAX }),
    ).toEqual({ text: "**hi**", attachments: [] });
  });

  it("normalizes richlinks to their URL", async () => {
    expect(
      await normalizePhotonContent(
        { type: "richlink", url: "https://example.com" },
        { maxBytes: MAX },
      ),
    ).toEqual({ text: "https://example.com", attachments: [] });
  });

  it("reads attachment bytes within the cap", async () => {
    const result = await normalizePhotonContent(
      {
        type: "attachment",
        name: "photo.jpg",
        mimeType: "image/jpeg",
        size: 3,
        read: async () => Buffer.from("abc"),
      },
      { maxBytes: MAX },
    );
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments[0]).toMatchObject({
      kind: "attachment",
      name: "photo.jpg",
      mimeType: "image/jpeg",
    });
    expect(result?.attachments[0]?.buffer?.toString()).toBe("abc");
  });

  it("degrades oversize attachments to a marker without reading", async () => {
    const read = vi.fn(async () => Buffer.alloc(MAX + 1));
    const declared = await normalizePhotonContent(
      { type: "attachment", name: "big.mov", mimeType: "video/quicktime", size: MAX + 1, read },
      { maxBytes: MAX },
    );
    expect(read).not.toHaveBeenCalled();
    expect(declared?.attachments[0]?.placeholder).toContain("big.mov");

    const undeclared = await normalizePhotonContent(
      { type: "voice", mimeType: "audio/mp4", read },
      { maxBytes: MAX },
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(undeclared?.attachments[0]?.placeholder).toContain("voice note");
  });

  it("degrades read failures to a marker instead of throwing", async () => {
    const onReadError = vi.fn();
    const result = await normalizePhotonContent(
      {
        type: "attachment",
        name: "broken.pdf",
        mimeType: "application/pdf",
        read: async () => {
          throw new Error("boom");
        },
      },
      { maxBytes: MAX, onReadError },
    );
    expect(onReadError).toHaveBeenCalledTimes(1);
    expect(result?.attachments[0]?.placeholder).toContain("broken.pdf");
  });

  it("skips unsupported content types", async () => {
    expect(await normalizePhotonContent({ type: "reaction" }, { maxBytes: MAX })).toBeNull();
    expect(await normalizePhotonContent({ type: "typing" }, { maxBytes: MAX })).toBeNull();
  });
});

describe("readPhotonReactionContent", () => {
  it("extracts tapback facts from reaction content", () => {
    expect(
      readPhotonReactionContent({
        type: "reaction",
        emoji: "❤️",
        target: { id: "m-1", direction: "outbound" },
      }),
    ).toEqual({ emoji: "❤️", targetMessageId: "m-1", targetDirection: "outbound" });
  });

  it("returns null for non-reaction or empty-emoji content", () => {
    expect(readPhotonReactionContent({ type: "text", text: "hi" })).toBeNull();
    expect(readPhotonReactionContent({ type: "reaction", emoji: " " })).toBeNull();
  });
});

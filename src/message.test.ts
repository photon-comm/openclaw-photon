// Photon tests cover reading Beta events into inbound messages.
import { describe, expect, it } from "vitest";
import { parsePhotonInbound } from "./message.js";

function received(content: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "message.received",
    data: {
      projectId: "pho_prj_1",
      object: {
        id: "pho_msg_1",
        platform: "imessage",
        status: "received",
        createdAt: "2026-11-13T00:00:00.000Z",
        sentBy: { id: "pho_usr_human", handle: "+15551234567", kind: "human" },
        receivedBy: { id: "pho_usr_line", handle: "+15557654321", kind: "agent" },
        space: { id: "pho_spc_1", kind: "direct" },
        content,
        ...overrides,
      },
    },
  };
}

describe("parsePhotonInbound", () => {
  it("reads a text message", () => {
    const parsed = parsePhotonInbound(received({ type: "text", format: "plain", text: "hi" }));
    expect(parsed).toEqual({
      messageId: "pho_msg_1",
      handle: "+15551234567",
      spaceId: "pho_spc_1",
      agentUserId: "pho_usr_line",
      agentHandle: "+15557654321",
      direct: true,
      text: "hi",
      attachments: [],
      unsupported: [],
      timestamp: Date.parse("2026-11-13T00:00:00.000Z"),
    });
  });

  it("reads attachments and text from a group of parts", () => {
    const parsed = parsePhotonInbound(
      received({
        type: "group",
        parts: [
          { type: "attachment", attachmentId: "pho_att_1" },
          { type: "text", format: "plain", text: "look" },
          { type: "poll", question: "?" },
        ],
      }),
    );
    expect(parsed?.text).toBe("look");
    expect(parsed?.attachments).toEqual([{ attachmentId: "pho_att_1", kind: "attachment" }]);
    expect(parsed?.unsupported).toEqual(["poll"]);
  });

  it("marks group chats", () => {
    const parsed = parsePhotonInbound(
      received({ type: "text", format: "plain", text: "hi" }, { space: { id: "pho_spc_g", kind: "group" } }),
    );
    expect(parsed?.direct).toBe(false);
  });

  it("ignores other events, other platforms and the agent's own messages", () => {
    expect(parsePhotonInbound({ type: "message.delivered", data: {} })).toBeNull();
    expect(
      parsePhotonInbound(received({ type: "text", text: "x" }, { platform: "sms" })),
    ).toBeNull();
    expect(
      parsePhotonInbound(
        received({ type: "text", text: "x" }, { sentBy: { id: "a", handle: "+1555", kind: "agent" } }),
      ),
    ).toBeNull();
  });

  it("keeps read receipts and typing out of the text", () => {
    const parsed = parsePhotonInbound(received({ type: "message.read" }));
    expect(parsed?.text).toBe("");
    expect(parsed?.unsupported).toEqual([]);
  });
});

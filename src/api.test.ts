// Photon tests cover finding the conversation for a handle and attachment uploads.
import { describe, expect, it, vi } from "vitest";
import { PhotonProjectApi } from "./api.js";
import { PhotonClient } from "./client.js";

function api() {
  return new PhotonProjectApi("pho_prj_1", "pho_sk_test", { origin: "https://api.test" });
}

describe("PhotonProjectApi.resolveConversation", () => {
  it("uses the handle's shared-line assignment", async () => {
    const photon = api();
    vi.spyOn(photon, "listAssignments").mockResolvedValue([
      { handle: "+15551234567", line: "+15550000001" },
    ]);
    const dedicated = vi.spyOn(photon, "listDedicatedLines").mockResolvedValue(["+15550000009"]);
    const user = vi
      .spyOn(photon, "createOrGetUser")
      .mockImplementation(async (handle) => (handle === "+15550000001" ? "pho_usr_line" : "pho_usr_peer"));
    const space = vi.spyOn(photon, "createOrGetSpace").mockResolvedValue("pho_spc_1");

    const conversation = await photon.resolveConversation("+1 555 123 4567");
    expect(conversation).toEqual({
      spaceId: "pho_spc_1",
      agentUserId: "pho_usr_line",
      agentHandle: "+15550000001",
    });
    expect(dedicated).not.toHaveBeenCalled();
    expect(user).toHaveBeenCalledWith("+15551234567");
    expect(space).toHaveBeenCalledWith("pho_usr_line", "pho_usr_peer");
  });

  it("falls back to the project's dedicated line", async () => {
    const photon = api();
    vi.spyOn(photon, "listAssignments").mockResolvedValue([]);
    vi.spyOn(photon, "listDedicatedLines").mockResolvedValue(["+15550000009"]);
    vi.spyOn(photon, "createOrGetUser").mockImplementation(async (handle) => `user:${handle}`);
    vi.spyOn(photon, "createOrGetSpace").mockResolvedValue("pho_spc_2");

    const conversation = await photon.resolveConversation("friend@example.com");
    expect(conversation.agentHandle).toBe("+15550000009");
    expect(conversation.agentUserId).toBe("user:+15550000009");
  });

  it("explains a project with no line for the handle", async () => {
    const photon = api();
    vi.spyOn(photon, "listAssignments").mockResolvedValue([]);
    vi.spyOn(photon, "listDedicatedLines").mockResolvedValue([]);
    await expect(photon.resolveConversation("+15551234567")).rejects.toThrow(/no iMessage line/);
  });
});

describe("PhotonProjectApi.upload", () => {
  it("posts multipart/related with the metadata part first", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "pho_att_1" }), { status: 201 }));
    const photon = new PhotonProjectApi("pho_prj_1", "pho_sk_test", {
      origin: "https://api.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const id = await photon.upload({ buffer: Buffer.from("abc"), contentType: "image/png", fileName: "a.png" });
    expect(id).toBe("pho_att_1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/projects/pho_prj_1/attachments");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toMatch(/^multipart\/related; boundary=openclaw-/);
    expect(headers.Authorization).toBe("Bearer pho_sk_test");
    const body = (init.body as Buffer).toString();
    expect(body).toContain('{"contentType":"image/png","sizeBytes":3,"filename":"a.png"}');
    expect(body.indexOf("application/json")).toBeLessThan(body.indexOf("abc"));
  });
});

describe("PhotonClient", () => {
  it("reuses the conversation an inbound message arrived in", async () => {
    const client = new PhotonClient({ accountId: "default", projectId: "pho_prj_1", apiKey: "k" });
    client.rememberConversation("+1 555 123 4567", { spaceId: "pho_spc_1", agentUserId: "pho_usr_line" });
    const resolve = vi.spyOn(client.api, "resolveConversation");
    const send = vi.spyOn(client.api, "sendText").mockResolvedValue({ id: "pho_msg_9" });

    const result = await client.sendText("+15551234567", "hello");
    expect(result).toEqual({ messageId: "pho_msg_9", spaceId: "pho_spc_1" });
    expect(resolve).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ spaceId: "pho_spc_1", agentUserId: "pho_usr_line" }, "hello");
  });
});

// Photon tests cover config schema behavior.
import { describe, expect, it } from "vitest";
import { PhotonConfigSchema } from "./config-schema.js";

describe("photon config schema", () => {
  it("accepts a minimal valid config", () => {
    const parsed = PhotonConfigSchema.safeParse({
      projectId: "proj-123",
      projectSecret: "secret",
      allowFrom: ["+15551234567"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dmPolicy).toBe("pairing");
      expect(parsed.data.reactions).toBeUndefined();
    }
  });

  it("rejects unknown keys", () => {
    const parsed = PhotonConfigSchema.safeParse({ projectId: "p", bogus: true });
    expect(parsed.success).toBe(false);
  });

  it('requires allowFrom "*" for open dmPolicy', () => {
    const rejected = PhotonConfigSchema.safeParse({
      projectId: "p",
      projectSecret: "s",
      dmPolicy: "open",
    });
    expect(rejected.success).toBe(false);

    const accepted = PhotonConfigSchema.safeParse({
      projectId: "p",
      projectSecret: "s",
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expect(accepted.success).toBe(true);
  });

  it("rejects group config (Photon does not support group chats)", () => {
    const parsed = PhotonConfigSchema.safeParse({
      projectId: "p",
      projectSecret: "s",
      groups: { "*": { requireMention: true } },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts reactions and defaultTo", () => {
    const parsed = PhotonConfigSchema.safeParse({
      projectId: "p",
      projectSecret: "s",
      reactions: true,
      defaultTo: "+15551234567",
    });
    expect(parsed.success).toBe(true);
  });
});

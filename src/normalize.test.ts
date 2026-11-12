// Photon tests cover handle, target and allowlist normalization.
import { describe, expect, it } from "vitest";
import {
  isHandlePhotonTarget,
  isValidPhotonHandle,
  looksLikePhotonTargetId,
  normalizePhotonAllowEntry,
  normalizePhotonHandle,
  normalizePhotonMessagingTarget,
} from "./normalize.js";

describe("photon normalize", () => {
  it("normalizes phone numbers and emails", () => {
    expect(normalizePhotonHandle("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizePhotonHandle("15551234567")).toBe("+15551234567");
    expect(normalizePhotonHandle(" You@iCloud.com ")).toBe("you@icloud.com");
  });

  it("validates handles", () => {
    expect(isValidPhotonHandle("+15551234567")).toBe(true);
    expect(isValidPhotonHandle("you@icloud.com")).toBe(true);
    expect(isValidPhotonHandle("+12")).toBe(false);
    expect(isValidPhotonHandle("pho_spc_abc")).toBe(false);
  });

  it("normalizes messaging targets", () => {
    expect(normalizePhotonMessagingTarget("photon:+15551234567")).toBe("+15551234567");
    expect(normalizePhotonMessagingTarget("user:+1 555 123 4567")).toBe("+15551234567");
    expect(normalizePhotonMessagingTarget("photon:Me@Example.com")).toBe("me@example.com");
    expect(normalizePhotonMessagingTarget("  ")).toBeUndefined();
    expect(normalizePhotonMessagingTarget("opaque-space-id")).toBeUndefined();
  });

  it("normalizes allowlist entries to comparable sender handles", () => {
    expect(normalizePhotonAllowEntry("photon:+15551234567")).toBe("+15551234567");
    expect(normalizePhotonAllowEntry("+1 555-123-4567")).toBe("+15551234567");
    expect(normalizePhotonAllowEntry("You@iCloud.com")).toBe("you@icloud.com");
    expect(normalizePhotonAllowEntry("*")).toBe("*");
    expect(normalizePhotonAllowEntry("")).toBe("");
  });

  it("classifies targets", () => {
    expect(isHandlePhotonTarget("photon:+15551234567")).toBe(true);
    expect(isHandlePhotonTarget("group-guid")).toBe(false);
    expect(looksLikePhotonTargetId("you@icloud.com")).toBe(true);
    expect(looksLikePhotonTargetId("")).toBe(false);
  });
});

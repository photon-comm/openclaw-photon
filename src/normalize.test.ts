// Photon tests cover normalize helper behavior.
import { describe, expect, it } from "vitest";
import {
  isPhonePhotonTarget,
  looksLikePhotonTargetId,
  normalizePhotonAllowEntry,
  normalizePhotonMessagingTarget,
  phoneTargetFromSpaceId,
} from "./normalize.js";

describe("photon normalize", () => {
  it("extracts phones from bare numbers and DM chat guids", () => {
    expect(phoneTargetFromSpaceId("+15551234567")).toBe("+15551234567");
    expect(phoneTargetFromSpaceId("any;-;+15551234567")).toBe("+15551234567");
    expect(phoneTargetFromSpaceId("group-guid-123")).toBeNull();
    expect(phoneTargetFromSpaceId("+12")).toBeNull();
  });

  it("normalizes messaging targets", () => {
    expect(normalizePhotonMessagingTarget("photon:+15551234567")).toBe("+15551234567");
    expect(normalizePhotonMessagingTarget("user:+15551234567")).toBe("+15551234567");
    expect(normalizePhotonMessagingTarget("any;-;+15551234567")).toBe("+15551234567");
    expect(normalizePhotonMessagingTarget("opaque-space-guid")).toBe("opaque-space-guid");
    expect(normalizePhotonMessagingTarget("  ")).toBeUndefined();
    expect(normalizePhotonMessagingTarget("has whitespace")).toBeUndefined();
  });

  it("normalizes allowlist entries to comparable sender ids", () => {
    expect(normalizePhotonAllowEntry("photon:+15551234567")).toBe("+15551234567");
    expect(normalizePhotonAllowEntry("any;-;+15551234567")).toBe("+15551234567");
    expect(normalizePhotonAllowEntry("*")).toBe("*");
    expect(normalizePhotonAllowEntry("")).toBe("");
  });

  it("classifies phone targets", () => {
    expect(isPhonePhotonTarget("+15551234567")).toBe(true);
    expect(isPhonePhotonTarget("group-guid")).toBe(false);
    expect(looksLikePhotonTargetId("+15551234567")).toBe(true);
    expect(looksLikePhotonTargetId("")).toBe(false);
  });
});

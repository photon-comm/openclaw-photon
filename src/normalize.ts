// Photon helper module supports target/allowlist normalization behavior.

// Photon represents iMessage DM chat ids as `any;-;+15551234567`; the captured
// phone addresses the same DM, so both forms normalize to the bare E.164 target.
const DM_CHAT_GUID_RE = /^any;-;(\+\d{6,})$/;
const E164_RE = /^\+\d{6,}$/;

function stripPhotonPrefix(raw: string): string {
  let value = raw.trim();
  if (/^photon:/i.test(value)) {
    value = value.slice("photon:".length).trim();
  }
  if (/^user:/i.test(value)) {
    value = value.slice("user:".length).trim();
  }
  return value;
}

/** Extract the E.164 phone from a bare number or a Photon DM chat guid. */
export function phoneTargetFromSpaceId(spaceId: string): string | null {
  const trimmed = spaceId.trim();
  if (E164_RE.test(trimmed)) {
    return trimmed;
  }
  const dmGuid = trimmed.match(DM_CHAT_GUID_RE);
  return dmGuid ? dmGuid[1] : null;
}

export function isPhonePhotonTarget(raw: string): boolean {
  return E164_RE.test(stripPhotonPrefix(raw));
}

/**
 * Normalize an outbound Photon target. Accepts bare E.164 phones, DM chat
 * guids, and opaque Spectrum space ids (group guids), with optional
 * `photon:`/`user:` prefixes.
 */
export function normalizePhotonMessagingTarget(raw: string): string | undefined {
  const value = stripPhotonPrefix(raw);
  if (!value || /\s/.test(value)) {
    return undefined;
  }
  return phoneTargetFromSpaceId(value) ?? value;
}

export function looksLikePhotonTargetId(raw: string): boolean {
  return normalizePhotonMessagingTarget(raw) !== undefined;
}

/** Normalize an allowlist entry to a comparable sender id (E.164 preferred). */
export function normalizePhotonAllowEntry(raw: string): string {
  const value = stripPhotonPrefix(raw);
  if (!value) {
    return "";
  }
  if (value === "*") {
    return "*";
  }
  return (phoneTargetFromSpaceId(value) ?? value).toLowerCase();
}

/** Normalize an inbound sender id for allowlist comparison. */
export function normalizePhotonSenderId(raw: string): string {
  return normalizePhotonAllowEntry(raw);
}

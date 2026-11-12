// Photon handles, targets and allowlist entries.
//
// An iMessage handle on Photon is an E.164 phone number (`+15551234567`) or
// an Apple-account email. Phone numbers lose formatting; emails are compared
// lowercase.

const E164_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/** `+1 (555) 123-4567` -> `+15551234567`; emails lowercase; anything else trimmed. */
export function normalizePhotonHandle(raw: string): string {
  const value = raw.trim();
  if (value.includes("@")) {
    return value.toLowerCase();
  }
  if (/^\+?[\d\s().-]+$/.test(value)) {
    const digits = value.replace(/[^\d+]/g, "");
    return digits.startsWith("+") ? digits : `+${digits}`;
  }
  return value;
}

export function isPhotonPhone(raw: string): boolean {
  return E164_RE.test(raw);
}

export function isPhotonEmail(raw: string): boolean {
  return EMAIL_RE.test(raw);
}

/** A phone number in E.164 form or an iMessage email. */
export function isValidPhotonHandle(raw: string): boolean {
  const value = normalizePhotonHandle(raw);
  return isPhotonPhone(value) || isPhotonEmail(value);
}

export function isHandlePhotonTarget(raw: string): boolean {
  return isValidPhotonHandle(stripPhotonPrefix(raw));
}

/** Normalize an outbound target: a phone or email, with optional `photon:`/`user:` prefixes. */
export function normalizePhotonMessagingTarget(raw: string): string | undefined {
  const value = stripPhotonPrefix(raw);
  if (!value || !isValidPhotonHandle(value)) {
    return undefined;
  }
  return normalizePhotonHandle(value);
}

export function looksLikePhotonTargetId(raw: string): boolean {
  return normalizePhotonMessagingTarget(raw) !== undefined;
}

/** Normalize an allowlist entry to a comparable sender handle. */
export function normalizePhotonAllowEntry(raw: string): string {
  const value = stripPhotonPrefix(raw);
  if (!value) {
    return "";
  }
  if (value === "*") {
    return "*";
  }
  return normalizePhotonHandle(value);
}

/** Normalize an inbound sender handle for allowlist comparison. */
export function normalizePhotonSenderId(raw: string): string {
  return normalizePhotonAllowEntry(raw);
}

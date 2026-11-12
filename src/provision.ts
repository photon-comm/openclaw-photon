// Setup-time client for the Photon dashboard (app.photon.codes) and the
// Spectrum Cloud API, following the flow of Photon's own CLI:
//   - device login (RFC 8628) against `/api/auth/device/*`
//   - find or create the project and read its Spectrum credentials
//   - register the operator's phone as a Spectrum user (idempotent)
//   - read the iMessage line that user should text
//
// Plain HTTP on global fetch, independent of the Spectrum SDK, so the setup
// wizard never loads the gRPC runtime. The device token is only used during
// setup and never stored; only the project id and secret land in config.

// Hosted Photon allowlists registered device clients; use Photon's published
// CLI device client id (matches `CLI_CLIENT_ID` in photon-hq/cli).
const DEVICE_CLIENT_ID = "photon-cli";
const DEVICE_SCOPE = "openid profile email";
const DEFAULT_DASHBOARD_HOST = "https://app.photon.codes";
const DEFAULT_SPECTRUM_HOST = "https://spectrum.photon.codes";
export const DEFAULT_PHOTON_PROJECT_NAME = "OpenClaw";

// RFC 8628 polling fallbacks; the device-code response interval/expiry wins.
const DEFAULT_POLL_INTERVAL_S = 5;
const DEFAULT_POLL_TIMEOUT_S = 1800;

const E164_RE = /^\+[1-9]\d{6,14}$/;

export type PhotonDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInS: number;
  intervalS: number;
};

export type PhotonProvisionedProject = {
  dashboardProjectId: string;
  spectrumProjectId: string;
  projectSecret: string;
  projectName: string;
  /** True when setup had to regenerate the secret (the old one stopped working). */
  secretRotated: boolean;
};

export type PhotonProvisionDeps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function dashboardHost(): string {
  return (process.env.PHOTON_DASHBOARD_HOST || DEFAULT_DASHBOARD_HOST).replace(/\/+$/, "");
}

function spectrumHost(): string {
  return (process.env.PHOTON_SPECTRUM_HOST || DEFAULT_SPECTRUM_HOST).replace(/\/+$/, "");
}

function resolveDeps(deps?: PhotonProvisionDeps) {
  return {
    fetchImpl: deps?.fetchImpl ?? fetch,
    sleep:
      deps?.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        })),
    now: deps?.now ?? (() => Date.now()),
  };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function basic(projectId: string, projectSecret: string): Record<string, string> {
  const encoded = Buffer.from(`${projectId}:${projectSecret}`, "utf8").toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

async function readJsonValue(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return asRecord(await readJsonValue(response));
}

function errorDetail(body: Record<string, unknown>): string {
  for (const key of ["error", "message", "detail"]) {
    const value = body[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return JSON.stringify(body).slice(0, 300);
}

/** Parse a response that must succeed; returns the raw JSON (object or array). */
async function requireOkData(response: Response, action: string): Promise<unknown> {
  const data = await readJsonValue(response);
  const body = asRecord(data);
  if (!response.ok) {
    throw new Error(`Photon ${action} failed: HTTP ${response.status}: ${errorDetail(body)}`);
  }
  // The dashboard reports some failures as HTTP 200 with an `error` field.
  if (typeof body.error === "string" && body.error) {
    throw new Error(`Photon ${action} failed: ${body.error}`);
  }
  return data;
}

async function requireOk(response: Response, action: string): Promise<Record<string, unknown>> {
  return asRecord(await requireOkData(response, action));
}

// The dashboard wraps list payloads inconsistently across versions
// (bare array, {data}, {projects}, {users}, {lines}, {items}).
function unwrapList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data as Array<Record<string, unknown>>;
  }
  if (data && typeof data === "object") {
    for (const key of ["data", "projects", "users", "lines", "items"]) {
      const inner = (data as Record<string, unknown>)[key];
      if (Array.isArray(inner)) {
        return inner as Array<Record<string, unknown>>;
      }
    }
  }
  return [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Device login (RFC 8628)

export async function requestPhotonDeviceCode(
  deps?: PhotonProvisionDeps,
): Promise<PhotonDeviceCode> {
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(`${dashboardHost()}/api/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: DEVICE_CLIENT_ID, scope: DEVICE_SCOPE }),
  });
  const body = await requireOk(response, "device-code request");
  const deviceCode = asString(body.device_code);
  const userCode = asString(body.user_code);
  const verificationUri = asString(body.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(
      "Photon device-code response is missing device_code/user_code/verification_uri",
    );
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: asString(body.verification_uri_complete),
    expiresInS: Number(body.expires_in) > 0 ? Number(body.expires_in) : DEFAULT_POLL_TIMEOUT_S,
    intervalS: Number(body.interval) > 0 ? Number(body.interval) : DEFAULT_POLL_INTERVAL_S,
  };
}

// The device-token endpoint has returned the bearer under several keys across
// versions; collect every shape and let validation pick the working one.
function deviceTokenCandidates(body: Record<string, unknown>, headers: Headers): string[] {
  const candidates: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const token = value.replace(/^bearer\s+/i, "").trim();
    if (token && !candidates.includes(token)) {
      candidates.push(token);
    }
  };
  add(body.access_token);
  add(body.accessToken);
  const session = body.session;
  if (session && typeof session === "object") {
    add((session as Record<string, unknown>).access_token);
  }
  const data = body.data;
  if (data && typeof data === "object") {
    add((data as Record<string, unknown>).access_token);
    add((data as Record<string, unknown>).accessToken);
  }
  add(headers.get("set-auth-token"));
  return candidates;
}

export async function pollPhotonDeviceToken(
  code: PhotonDeviceCode,
  opts?: { onPending?: () => void; deps?: PhotonProvisionDeps },
): Promise<string> {
  const { fetchImpl, sleep, now } = resolveDeps(opts?.deps);
  const deadline = now() + code.expiresInS * 1000;
  let intervalS = code.intervalS;
  while (now() < deadline) {
    await sleep(intervalS * 1000);
    let response: Response;
    try {
      response = await fetchImpl(`${dashboardHost()}/api/auth/device/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code.deviceCode,
          client_id: DEVICE_CLIENT_ID,
        }),
      });
    } catch {
      // Transient network failure mid-poll; keep waiting for approval.
      continue;
    }
    if (response.status === 200) {
      const body = await readJson(response);
      const candidates = deviceTokenCandidates(body, response.headers);
      const token = await firstDashboardValidToken(candidates, opts?.deps);
      if (!token) {
        throw new Error(
          "Photon returned a device token, but the dashboard project API rejected every candidate.",
        );
      }
      return token;
    }
    if (response.status === 429) {
      // RFC 8628 §3.5 — treat 429 as slow_down.
      intervalS += 10;
      opts?.onPending?.();
      continue;
    }
    if (response.status === 400) {
      const body = await readJson(response);
      const err = asString(body.error) ?? asString(body.message) ?? "";
      if (err === "authorization_pending") {
        opts?.onPending?.();
        continue;
      }
      if (err === "slow_down") {
        intervalS += 5;
        opts?.onPending?.();
        continue;
      }
      throw new Error(`Photon device login failed: ${err || "unexpected 400"}`);
    }
    // Unexpected status: keep polling until the code expires.
  }
  throw new Error("Photon device login timed out before the request was approved");
}

// The device flow can mint a token that passes the session lookup but is
// rejected by the project APIs; validate against both before trusting it.
async function isDashboardValidToken(token: string, deps?: PhotonProvisionDeps): Promise<boolean> {
  const { fetchImpl } = resolveDeps(deps);
  const session = await fetchImpl(`${dashboardHost()}/api/auth/get-session`, {
    headers: bearer(token),
  });
  if (!session.ok) {
    return false;
  }
  const sessionBody = await readJson(session);
  const user = sessionBody.user;
  if (!user || typeof user !== "object") {
    return false;
  }
  const projects = await fetchImpl(`${dashboardHost()}/api/projects/`, {
    headers: bearer(token),
  });
  return projects.ok;
}

async function firstDashboardValidToken(
  candidates: string[],
  deps?: PhotonProvisionDeps,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isDashboardValidToken(candidate, deps)) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dashboard API: projects + lines

async function listProjects(
  token: string,
  deps?: PhotonProvisionDeps,
): Promise<Array<Record<string, unknown>>> {
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(`${dashboardHost()}/api/projects`, { headers: bearer(token) });
  return unwrapList(await requireOkData(response, "list-projects"));
}

async function getProject(
  token: string,
  projectId: string,
  deps?: PhotonProvisionDeps,
): Promise<Record<string, unknown>> {
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(`${dashboardHost()}/api/projects/${projectId}`, {
    headers: bearer(token),
  });
  return await requireOk(response, "get-project");
}

async function createProject(
  token: string,
  name: string,
  deps?: PhotonProvisionDeps,
): Promise<string> {
  const { fetchImpl } = resolveDeps(deps);
  // Every project on the Stable dashboard gets a Spectrum project at create
  // time (the dashboard id is the Spectrum project id); ask for iMessage.
  const response = await fetchImpl(`${dashboardHost()}/api/projects`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      location: "United States",
      platforms: ["imessage"],
    }),
  });
  const body = await requireOk(response, "create-project");
  const id = asString(body.id);
  if (!id) {
    throw new Error("Photon create-project did not return a project id");
  }
  return id;
}

async function regenerateProjectSecret(
  token: string,
  projectId: string,
  deps?: PhotonProvisionDeps,
): Promise<string> {
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(
    `${dashboardHost()}/api/projects/${projectId}/regenerate-secret`,
    {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: "{}",
    },
  );
  const body = await requireOk(response, "regenerate-secret");
  const secret = asString(body.projectSecret);
  if (!secret) {
    throw new Error("Photon regenerate-secret returned no projectSecret");
  }
  return secret;
}

/** Project's iMessage line (the number users text to reach the agent). */
export async function getPhotonImessageLine(
  token: string,
  dashboardProjectId: string,
  deps?: PhotonProvisionDeps,
): Promise<string | undefined> {
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(`${dashboardHost()}/api/projects/${dashboardProjectId}/lines`, {
    headers: bearer(token),
  });
  const lines = unwrapList(await requireOkData(response, "list-lines"));
  const line = lines.find((entry) => asString(entry.platform)?.toLowerCase() === "imessage");
  return line ? asString(line.phoneNumber) : undefined;
}

/**
 * Find or create the named project and read its Spectrum credentials. The
 * device-login session is first-party, so the dashboard returns the current
 * project secret and nothing is rotated; the secret is regenerated only when
 * the dashboard has none to show (which invalidates the old one). Re-running
 * setup reuses the existing project, so a partial setup can be finished.
 */
export async function provisionPhotonProject(params: {
  token: string;
  projectName?: string;
  deps?: PhotonProvisionDeps;
}): Promise<PhotonProvisionedProject> {
  const projectName = params.projectName?.trim() || DEFAULT_PHOTON_PROJECT_NAME;
  const target = projectName.toLowerCase();
  const existing = (await listProjects(params.token, params.deps)).find(
    (project) => asString(project.name)?.toLowerCase() === target,
  );
  const dashboardProjectId =
    (existing ? asString(existing.id) : undefined) ??
    (await createProject(params.token, projectName, params.deps));
  const project = await getProject(params.token, dashboardProjectId, params.deps);
  // Older dashboards kept a separate Spectrum id; current ones reuse the
  // project id for Spectrum.
  const spectrumProjectId = asString(project.spectrumProjectId) ?? dashboardProjectId;
  const projectSecret =
    asString(project.projectSecret) ??
    (await regenerateProjectSecret(params.token, dashboardProjectId, params.deps));
  return {
    dashboardProjectId,
    spectrumProjectId,
    projectSecret,
    projectName: asString(project.name) ?? projectName,
    secretRotated: !asString(project.projectSecret),
  };
}

// ---------------------------------------------------------------------------
// Spectrum API: users (Basic auth with the spectrum project credentials)

function normalizePhoneDigits(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

export function isValidPhotonPhone(phone: string): boolean {
  return E164_RE.test(normalizePhoneDigits(phone));
}

/**
 * Idempotently register the operator's phone as a Spectrum user. Returns the
 * user's `assignedPhoneNumber` (the iMessage line to text) when assigned.
 */
export async function registerPhotonUser(params: {
  spectrumProjectId: string;
  projectSecret: string;
  phoneNumber: string;
  deps?: PhotonProvisionDeps;
}): Promise<{ created: boolean; assignedPhoneNumber?: string }> {
  const { fetchImpl } = resolveDeps(params.deps);
  const phone = normalizePhoneDigits(params.phoneNumber);
  if (!E164_RE.test(phone)) {
    throw new Error(`Phone number must be E.164 (e.g. +15551234567); got ${params.phoneNumber}`);
  }
  const auth = basic(params.spectrumProjectId, params.projectSecret);
  const listResponse = await fetchImpl(
    `${spectrumHost()}/projects/${params.spectrumProjectId}/users/`,
    { headers: auth },
  );
  const users = unwrapList(await requireOkData(listResponse, "list-users"));
  const existing = users.find(
    (user) => normalizePhoneDigits(asString(user.phoneNumber) ?? "") === phone,
  );
  if (existing) {
    return { created: false, assignedPhoneNumber: asString(existing.assignedPhoneNumber) };
  }
  const createResponse = await fetchImpl(
    `${spectrumHost()}/projects/${params.spectrumProjectId}/users/`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "shared", phoneNumber: phone }),
    },
  );
  const body = await requireOk(createResponse, "create-user");
  const user =
    (body.user && typeof body.user === "object" ? (body.user as Record<string, unknown>) : null) ??
    (body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : null) ??
    body;
  return { created: true, assignedPhoneNumber: asString(user.assignedPhoneNumber) };
}

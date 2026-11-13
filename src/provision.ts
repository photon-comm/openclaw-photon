// Setup-time calls to Photon Beta, made with the person's own sign-in:
//   - device login (RFC 8628), the same flow as `photon login` in the CLI
//   - pick the organization and project, or create the project, and wait
//     until Photon has set up its billing
//   - create a project API key for the gateway
//   - give the person a line: a shared-line assignment for their handle, or
//     the project's dedicated line
//
// The sign-in token is only used during setup and never stored; only the
// project id and its API key go into the config. The API client is imported
// lazily so cold plugin loads don't pay for it.
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Photon } from "@photon-ai/api";
import { normalizePhotonHandle } from "./normalize.js";
import { photonApiOrigin } from "./origin.js";

export const DEFAULT_PHOTON_PROJECT_NAME = "OpenClaw";
/** What the gateway does: read events and messages, send, read line settings. */
export const PHOTON_GATEWAY_KEY_PERMISSIONS = ["project:read", "project:write", "platforms:read"];

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_S = 5;
const DEFAULT_EXPIRES_IN_S = 900;
// A new project answers 202 while its billing is set up; Photon asks for a
// GET every Retry-After (2 seconds) until that settles.
const PROJECT_BILLING_POLL_MS = 2_000;
const PROJECT_BILLING_TIMEOUT_MS = 120_000;

export type PhotonProvisionDeps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type PhotonDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInS: number;
  intervalS: number;
};

export type PhotonSignIn = { token: string; email?: string };
export type PhotonOrganization = { organizationId: string; name: string };
export type PhotonProjectSummary = {
  projectId: string;
  name: string;
  /** False while Photon is still setting up the project's billing. */
  ready?: boolean;
};
export type PhotonImessageMode =
  | { mode: "shared"; maxUserAssignments?: number }
  | { mode: "dedicated" }
  | { mode: "unknown" };

async function client(token: string | undefined, deps?: PhotonProvisionDeps): Promise<Photon> {
  const { Photon } = await import("@photon-ai/api");
  return new Photon({
    baseUrl: photonApiOrigin(),
    ...(deps?.fetchImpl ? { fetch: deps.fetchImpl } : {}),
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
}

function resolveDeps(deps?: PhotonProvisionDeps) {
  return {
    sleep:
      deps?.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        })),
    now: deps?.now ?? (() => Date.now()),
  };
}

// ---------------------------------------------------------------------------
// Device login

export async function requestPhotonDeviceCode(deps?: PhotonProvisionDeps): Promise<PhotonDeviceCode> {
  const photon = await client(undefined, deps);
  const auth = await photon.auth.device.authorize({});
  return {
    deviceCode: auth.device_code,
    userCode: auth.user_code,
    verificationUri: auth.verification_uri,
    verificationUriComplete: auth.verification_uri_complete || undefined,
    expiresInS: auth.expires_in > 0 ? auth.expires_in : DEFAULT_EXPIRES_IN_S,
    intervalS: auth.interval > 0 ? auth.interval : DEFAULT_POLL_INTERVAL_S,
  };
}

function oauthError(err: unknown): { status?: number; error?: string } {
  if (!err || typeof err !== "object") {
    return {};
  }
  const status = (err as { status?: unknown }).status;
  const body = (err as { body?: unknown }).body;
  const error =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? ((body as { error: string }).error as string)
      : undefined;
  return { status: typeof status === "number" ? status : undefined, error };
}

/** Wait for the person to approve the sign-in; returns the account token. */
export async function pollPhotonDeviceToken(
  code: PhotonDeviceCode,
  opts?: { onPending?: () => void; deps?: PhotonProvisionDeps },
): Promise<PhotonSignIn> {
  const { sleep, now } = resolveDeps(opts?.deps);
  const photon = await client(undefined, opts?.deps);
  const deadline = now() + code.expiresInS * 1000;
  let intervalS = code.intervalS;
  while (now() < deadline) {
    await sleep(intervalS * 1000);
    try {
      const grant = await photon.auth.device.token({
        body: { device_code: code.deviceCode, grant_type: DEVICE_GRANT_TYPE },
      });
      return { token: grant.access_token, email: grant.user?.email };
    } catch (err) {
      const { status, error } = oauthError(err);
      if (error === "authorization_pending") {
        opts?.onPending?.();
        continue;
      }
      if (error === "slow_down" || status === 429) {
        intervalS += 5;
        continue;
      }
      if (error === "access_denied") {
        throw new Error("The Photon sign-in was denied in the browser.");
      }
      if (error === "expired_token") {
        break;
      }
      if (status === undefined || status >= 500) {
        // Network or server trouble mid-poll: keep waiting for approval.
        continue;
      }
      throw new Error(`Photon sign-in failed: ${error ?? `HTTP ${status}`}`);
    }
  }
  throw new Error("The Photon sign-in code expired before it was approved. Run setup again.");
}

// ---------------------------------------------------------------------------
// Organizations and projects

export async function listPhotonOrganizations(
  token: string,
  deps?: PhotonProvisionDeps,
): Promise<PhotonOrganization[]> {
  const photon = await client(token, deps);
  const result = await photon.organizations.listOrganizations({});
  return result.organizations.map((org) => ({ organizationId: org.organizationId, name: org.name }));
}

export async function listPhotonProjects(
  token: string,
  organizationId: string,
  deps?: PhotonProvisionDeps,
): Promise<PhotonProjectSummary[]> {
  const photon = await client(token, deps);
  const projects: PhotonProjectSummary[] = [];
  let pageToken: string | undefined;
  do {
    const page = await photon.organizations.projects.list({
      path: { organizationId },
      ...(pageToken ? { query: { pageToken } } : {}),
    });
    for (const project of page.projects) {
      if (!project.deletedAt) {
        projects.push({
          projectId: project.projectId,
          name: project.name,
          ready: photonBillingSettled(project.billingInitialization),
        });
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return projects;
}

/** A slug Photon accepts: lowercase words joined by single hyphens, globally unique. */
export function photonProjectSlug(name: string, suffix = randomBytes(3).toString("hex")): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "openclaw";
  return `${base}-${suffix}`;
}

/**
 * Whether a project's billing is set up. `pending` and `retry_required` mean
 * Photon is still working on it; until then line settings and assignments
 * answer 503. A project without the field is ready.
 */
export function photonBillingSettled(state: string | null | undefined): boolean {
  return state !== "pending" && state !== "retry_required";
}

async function waitForPhotonBilling(
  photon: Photon,
  projectId: string,
  initial: string | null | undefined,
  deps?: PhotonProvisionDeps,
): Promise<void> {
  const { sleep, now } = resolveDeps(deps);
  const deadline = now() + PROJECT_BILLING_TIMEOUT_MS;
  let state = initial;
  while (!photonBillingSettled(state)) {
    if (now() >= deadline) {
      throw new Error(
        `Photon is still setting up project ${projectId}. Wait a minute, then run setup again and pick the project from the list.`,
      );
    }
    await sleep(PROJECT_BILLING_POLL_MS);
    const project = await photon.projects.get({ path: { projectId } });
    state = project.billingInitialization;
  }
}

/** Wait until Photon has finished setting up an existing project. */
export async function waitForPhotonProject(
  token: string,
  projectId: string,
  deps?: PhotonProvisionDeps,
): Promise<void> {
  const photon = await client(token, deps);
  const project = await photon.projects.get({ path: { projectId } });
  await waitForPhotonBilling(photon, projectId, project.billingInitialization, deps);
}

/** Create the project and return once Photon has set it up. */
export async function createPhotonProject(
  token: string,
  organizationId: string,
  name: string,
  deps?: PhotonProvisionDeps,
): Promise<PhotonProjectSummary> {
  const photon = await client(token, deps);
  const project = await photon.organizations.projects.create({
    path: { organizationId },
    headers: { idempotencyKey: `openclaw-project:${randomUUID()}` },
    body: { name, slug: photonProjectSlug(name) },
  });
  await waitForPhotonBilling(photon, project.projectId, project.billingInitialization, deps);
  return { projectId: project.projectId, name: project.name, ready: true };
}

/** A project API key for the gateway; the secret is only returned here. */
export async function createPhotonGatewayKey(
  token: string,
  projectId: string,
  deps?: PhotonProvisionDeps,
): Promise<{ apiKeyId: string; secret: string; name: string }> {
  const photon = await client(token, deps);
  const name = `OpenClaw gateway (${hostname()})`.slice(0, 128);
  const created = await photon.projects.createProjectApiKey({
    path: { projectId },
    headers: { idempotencyKey: `openclaw-key:${randomUUID()}` },
    body: { name, permissions: PHOTON_GATEWAY_KEY_PERMISSIONS },
  });
  return { apiKeyId: created.apiKey.apiKeyId, secret: created.secret, name };
}

// ---------------------------------------------------------------------------
// iMessage lines

export async function getPhotonImessageMode(
  token: string,
  projectId: string,
  deps?: PhotonProvisionDeps,
): Promise<PhotonImessageMode> {
  const photon = await client(token, deps);
  const settings = await photon.projects.platforms.getImessage({ path: { id: projectId } });
  if (settings.mode === "shared") {
    return { mode: "shared", maxUserAssignments: settings.maxUserAssignments };
  }
  if (settings.mode === "dedicated") {
    return { mode: "dedicated" };
  }
  return { mode: "unknown" };
}

/**
 * The shared line `handle` texts: its existing assignment, or a new one (a
 * seat from the project's plan).
 */
export async function ensurePhotonSharedLine(
  token: string,
  projectId: string,
  handle: string,
  deps?: PhotonProvisionDeps,
): Promise<{ line: string; created: boolean }> {
  const photon = await client(token, deps);
  const wanted = normalizePhotonHandle(handle);
  let pageToken: string | undefined;
  do {
    const page = await photon.projects.platforms.imessage.assignments.list({
      path: { id: projectId },
      ...(pageToken ? { query: { pageToken } } : {}),
    });
    const existing = page.assignments.find(
      (entry) => !entry.releasedAt && normalizePhotonHandle(entry.handle) === wanted,
    );
    if (existing) {
      return { line: existing.assignedPhoneNumber, created: false };
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  const assignment = await photon.projects.platforms.imessage.assignments.create({
    path: { id: projectId },
    headers: { idempotencyKey: `openclaw-assign:${projectId}:${wanted}` },
    body: { handle: wanted },
  });
  return { line: assignment.assignedPhoneNumber, created: true };
}

export async function listPhotonDedicatedLines(
  token: string,
  projectId: string,
  deps?: PhotonProvisionDeps,
): Promise<string[]> {
  const photon = await client(token, deps);
  const lines: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await photon.projects.platforms.listResources({
      path: { id: projectId },
      ...(pageToken ? { query: { pageToken } } : {}),
    });
    for (const resource of page.resources) {
      const phone = (resource.detail as { phoneNumber?: unknown }).phoneNumber;
      if (resource.state === "active" && resource.abilities.includes("imessage") && typeof phone === "string") {
        lines.push(phone);
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return lines;
}

/** One readable line for an error from a setup call. */
export function describeProvisionError(err: unknown): string {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    const body = (err as { body?: unknown }).body as { code?: unknown; detail?: unknown } | undefined;
    const code = typeof body?.code === "string" ? ` ${body.code}` : "";
    const detail = typeof body?.detail === "string" ? `: ${body.detail}` : "";
    return `Photon ${String(status)}${code}${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

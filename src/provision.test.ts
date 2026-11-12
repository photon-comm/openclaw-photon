// Tests for device login, project provisioning and user registration.
import { describe, expect, it, vi } from "vitest";
import {
  pollPhotonDeviceToken,
  provisionPhotonProject,
  registerPhotonUser,
  requestPhotonDeviceCode,
  type PhotonDeviceCode,
} from "./provision.js";

type FetchCall = { url: string; method: string; body?: string };

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function createFetchQueue(responses: Array<(call: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const next = responses.shift();
    if (!next) {
      throw new Error(`unexpected fetch: ${call.url}`);
    }
    return next(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const deps = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  sleep: async () => {},
  now: (() => {
    let tick = 0;
    return () => (tick += 1000);
  })(),
});

describe("photon device login", () => {
  it("requests a device code", async () => {
    const { fetchImpl, calls } = createFetchQueue([
      () =>
        jsonResponse(200, {
          device_code: "dev-1",
          user_code: "ABCD-1234",
          verification_uri: "https://app.photon.codes/device",
          verification_uri_complete: "https://app.photon.codes/device?code=ABCD-1234",
          expires_in: 600,
          interval: 1,
        }),
    ]);

    const code = await requestPhotonDeviceCode({ fetchImpl });
    expect(code.deviceCode).toBe("dev-1");
    expect(code.userCode).toBe("ABCD-1234");
    expect(code.verificationUriComplete).toContain("code=ABCD-1234");
    expect(calls[0]?.url).toBe("https://app.photon.codes/api/auth/device/code");
    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.client_id).toBe("photon-cli");
  });

  it("polls through authorization_pending and validates the token", async () => {
    const code: PhotonDeviceCode = {
      deviceCode: "dev-1",
      userCode: "ABCD-1234",
      verificationUri: "https://app.photon.codes/device",
      expiresInS: 600,
      intervalS: 1,
    };
    const onPending = vi.fn();
    const { fetchImpl, calls } = createFetchQueue([
      () => jsonResponse(400, { error: "authorization_pending" }),
      () => jsonResponse(200, { access_token: "token-1" }),
      // Token validation: session lookup + project list.
      () => jsonResponse(200, { user: { id: "user-1" } }),
      () => jsonResponse(200, []),
    ]);

    const token = await pollPhotonDeviceToken(code, { onPending, deps: deps(fetchImpl) });
    expect(token).toBe("token-1");
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.url.endsWith("/api/auth/device/token"))).toHaveLength(2);
  });

  it("aborts on access_denied", async () => {
    const code: PhotonDeviceCode = {
      deviceCode: "dev-1",
      userCode: "ABCD-1234",
      verificationUri: "https://app.photon.codes/device",
      expiresInS: 600,
      intervalS: 1,
    };
    const { fetchImpl } = createFetchQueue([() => jsonResponse(400, { error: "access_denied" })]);

    await expect(pollPhotonDeviceToken(code, { deps: deps(fetchImpl) })).rejects.toThrow(
      /access_denied/,
    );
  });
});

describe("photon project provisioning", () => {
  it("reuses an existing project and reads its secret without rotating it", async () => {
    const { fetchImpl, calls } = createFetchQueue([
      // list projects (the dashboard returns a bare array)
      () => jsonResponse(200, [{ id: "prj-1", name: "OpenClaw" }]),
      // get project: first-party sessions see the current secret
      () => jsonResponse(200, { id: "prj-1", name: "OpenClaw", projectSecret: "secret-1" }),
    ]);

    const project = await provisionPhotonProject({ token: "token-1", deps: deps(fetchImpl) });
    expect(project).toEqual({
      dashboardProjectId: "prj-1",
      spectrumProjectId: "prj-1",
      projectSecret: "secret-1",
      projectName: "OpenClaw",
      secretRotated: false,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://app.photon.codes/api/projects",
      "https://app.photon.codes/api/projects/prj-1",
    ]);
  });

  it("regenerates the secret only when the dashboard shows none", async () => {
    const { fetchImpl, calls } = createFetchQueue([
      () => jsonResponse(200, { data: [{ id: "prj-1", name: "openclaw" }] }),
      () => jsonResponse(200, { id: "prj-1", name: "OpenClaw", projectSecret: null }),
      () => jsonResponse(200, { success: true, projectSecret: "secret-2" }),
    ]);

    const project = await provisionPhotonProject({ token: "token-1", deps: deps(fetchImpl) });
    expect(project.projectSecret).toBe("secret-2");
    expect(project.secretRotated).toBe(true);
    expect(calls.at(-1)?.url).toBe("https://app.photon.codes/api/projects/prj-1/regenerate-secret");
  });

  it("keeps a separate Spectrum project id when an older dashboard returns one", async () => {
    const { fetchImpl } = createFetchQueue([
      () => jsonResponse(200, [{ id: "dash-1", name: "OpenClaw" }]),
      () =>
        jsonResponse(200, {
          id: "dash-1",
          name: "OpenClaw",
          spectrumProjectId: "spec-1",
          projectSecret: "secret-1",
        }),
    ]);

    const project = await provisionPhotonProject({ token: "token-1", deps: deps(fetchImpl) });
    expect(project.spectrumProjectId).toBe("spec-1");
  });

  it("creates the project with iMessage when missing", async () => {
    const { fetchImpl, calls } = createFetchQueue([
      () => jsonResponse(200, []),
      () => jsonResponse(200, { success: true, id: "prj-2" }),
      () => jsonResponse(200, { id: "prj-2", name: "OpenClaw", projectSecret: "secret-2" }),
    ]);

    const project = await provisionPhotonProject({ token: "token-1", deps: deps(fetchImpl) });
    expect(project.spectrumProjectId).toBe("prj-2");
    const createCall = calls[1];
    expect(createCall?.url).toBe("https://app.photon.codes/api/projects");
    expect(createCall?.method).toBe("POST");
    const body = JSON.parse(createCall?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ name: "OpenClaw", platforms: ["imessage"] });
  });

  it("surfaces errors the dashboard reports with HTTP 200", async () => {
    const { fetchImpl } = createFetchQueue([
      () => jsonResponse(200, []),
      () => jsonResponse(200, { error: "Spectrum provisioning failed: quota" }),
    ]);

    await expect(
      provisionPhotonProject({ token: "token-1", deps: deps(fetchImpl) }),
    ).rejects.toThrow(/Spectrum provisioning failed: quota/);
  });
});

describe("photon user registration", () => {
  it("is idempotent for an existing phone number", async () => {
    const { fetchImpl, calls } = createFetchQueue([
      () =>
        jsonResponse(200, {
          users: [{ phoneNumber: "+1 (555) 123-4567", assignedPhoneNumber: "+18880001111" }],
        }),
    ]);

    const result = await registerPhotonUser({
      spectrumProjectId: "spec-1",
      projectSecret: "secret-1",
      phoneNumber: "+15551234567",
      deps: deps(fetchImpl),
    });
    expect(result).toEqual({ created: false, assignedPhoneNumber: "+18880001111" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://spectrum.photon.codes/projects/spec-1/users/");
  });

  it("creates a shared user when absent", async () => {
    const { fetchImpl, calls } = createFetchQueue([
      () => jsonResponse(200, []),
      () =>
        jsonResponse(200, {
          user: { phoneNumber: "+15551234567", assignedPhoneNumber: "+18880002222" },
        }),
    ]);

    const result = await registerPhotonUser({
      spectrumProjectId: "spec-1",
      projectSecret: "secret-1",
      phoneNumber: "+15551234567",
      deps: deps(fetchImpl),
    });
    expect(result).toEqual({ created: true, assignedPhoneNumber: "+18880002222" });
    const body = JSON.parse(calls[1]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({ type: "shared", phoneNumber: "+15551234567" });
  });

  it("rejects non-E.164 numbers", async () => {
    const { fetchImpl } = createFetchQueue([]);
    await expect(
      registerPhotonUser({
        spectrumProjectId: "spec-1",
        projectSecret: "secret-1",
        phoneNumber: "555-1234",
        deps: deps(fetchImpl),
      }),
    ).rejects.toThrow(/E\.164/);
  });
});

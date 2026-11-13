// Photon tests cover the setup sign-in and project helpers.
import { describe, expect, it, vi } from "vitest";
import {
  createPhotonProject,
  listPhotonProjects,
  photonProjectSlug,
  pollPhotonDeviceToken,
  requestPhotonDeviceCode,
  waitForPhotonProject,
} from "./provision.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("device sign-in", () => {
  it("requests a device code", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        device_code: "dev-1",
        user_code: "ABCD-EFGH",
        verification_uri: "https://app.beta.photon.codes/device",
        verification_uri_complete: "https://app.beta.photon.codes/device?code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      }),
    );
    const code = await requestPhotonDeviceCode({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(code).toMatchObject({ deviceCode: "dev-1", userCode: "ABCD-EFGH", intervalS: 5, expiresInS: 600 });
    const request = (fetchImpl.mock.calls[0] as unknown[])[0] as Request;
    expect(request.url).toContain("/v1/auth/device/");
  });

  it("polls until the sign-in is approved, slowing down when asked", async () => {
    const responses = [
      json(400, { error: "authorization_pending" }),
      json(400, { error: "slow_down" }),
      json(200, {
        access_token: "token-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        user: { id: "pho_acc_1", email: "dev@example.com", first_name: null, last_name: null },
      }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() as Response);
    const sleeps: number[] = [];
    let clock = 0;
    const signIn = await pollPhotonDeviceToken(
      { deviceCode: "dev-1", userCode: "X", verificationUri: "https://x", expiresInS: 600, intervalS: 5 },
      {
        deps: {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
          },
          now: () => clock,
        },
      },
    );
    expect(signIn).toEqual({ token: "token-1", email: "dev@example.com" });
    expect(sleeps).toEqual([5000, 5000, 10000]);
  });

  it("stops when the sign-in is denied", async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: "access_denied" }));
    await expect(
      pollPhotonDeviceToken(
        { deviceCode: "d", userCode: "X", verificationUri: "https://x", expiresInS: 60, intervalS: 1 },
        { deps: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} } },
      ),
    ).rejects.toThrow(/denied/);
  });
});

function project(billingInitialization?: string) {
  return {
    projectId: "pho_prj_1",
    organizationId: "pho_org_1",
    name: "OpenClaw",
    slug: "openclaw-a1b2c3",
    agentProfile: { avatarUrl: "https://example.com/agent.png", firstName: "Agent", lastName: null },
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
    createdByAccountId: "pho_acc_1",
    createdByActorId: "pho_acc_1",
    createdByActorKind: "account",
    deletedAt: null,
    ...(billingInitialization ? { billingInitialization } : {}),
  };
}

function fakeClock() {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    },
  };
}

function requests(fetchImpl: ReturnType<typeof vi.fn>): string[] {
  return fetchImpl.mock.calls.map((call) => {
    const request = (call as unknown[])[0] as Request;
    return `${request.method} ${new URL(request.url).pathname}`;
  });
}

describe("createPhotonProject", () => {
  it("waits for Photon to set up billing after a 202", async () => {
    const responses = [
      json(202, project("pending")),
      json(200, project("retry_required")),
      json(200, project("completed")),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() as Response);
    const { sleeps, deps } = fakeClock();
    const created = await createPhotonProject("token", "pho_org_1", "OpenClaw", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...deps,
    });
    expect(created).toEqual({ projectId: "pho_prj_1", name: "OpenClaw", ready: true });
    expect(requests(fetchImpl)).toEqual([
      "POST /v1/organizations/pho_org_1/projects",
      "GET /v1/projects/pho_prj_1",
      "GET /v1/projects/pho_prj_1",
    ]);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("returns at once when the project is ready", async () => {
    const fetchImpl = vi.fn(async () => json(201, project("completed")));
    const created = await createPhotonProject("token", "pho_org_1", "OpenClaw", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...fakeClock().deps,
    });
    expect(created.projectId).toBe("pho_prj_1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up with a clear message when billing never settles", async () => {
    const fetchImpl = vi.fn(async (input: Request) =>
      input.method === "POST" ? json(202, project("pending")) : json(200, project("pending")),
    );
    await expect(
      createPhotonProject("token", "pho_org_1", "OpenClaw", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...fakeClock().deps,
      }),
    ).rejects.toThrow(/still setting up project pho_prj_1/);
  });
});

describe("existing projects", () => {
  it("marks projects whose billing is still being set up", async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        projects: [
          project("pending"),
          { ...project(), projectId: "pho_prj_2", name: "Other" },
          { ...project("completed"), projectId: "pho_prj_3", deletedAt: "2026-11-13T01:00:00.000Z" },
        ],
      }),
    );
    const projects = await listPhotonProjects("token", "pho_org_1", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(projects).toEqual([
      { projectId: "pho_prj_1", name: "OpenClaw", ready: false },
      { projectId: "pho_prj_2", name: "Other", ready: true },
    ]);
  });

  it("waits until an existing project is set up", async () => {
    const responses = [json(200, project("pending")), json(200, project("unknown"))];
    const fetchImpl = vi.fn(async () => responses.shift() as Response);
    const { sleeps, deps } = fakeClock();
    await waitForPhotonProject("token", "pho_prj_1", { fetchImpl: fetchImpl as unknown as typeof fetch, ...deps });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });
});

describe("photonProjectSlug", () => {
  it("makes a valid, unique-looking slug", () => {
    expect(photonProjectSlug("OpenClaw", "a1b2c3")).toBe("openclaw-a1b2c3");
    expect(photonProjectSlug("My  Agent!!", "000000")).toBe("my-agent-000000");
    expect(photonProjectSlug("***", "ffffff")).toBe("openclaw-ffffff");
  });
});

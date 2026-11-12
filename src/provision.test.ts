// Photon tests cover the setup sign-in and project helpers.
import { describe, expect, it, vi } from "vitest";
import { photonProjectSlug, pollPhotonDeviceToken, requestPhotonDeviceCode } from "./provision.js";

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

describe("photonProjectSlug", () => {
  it("makes a valid, unique-looking slug", () => {
    expect(photonProjectSlug("OpenClaw", "a1b2c3")).toBe("openclaw-a1b2c3");
    expect(photonProjectSlug("My  Agent!!", "000000")).toBe("my-agent-000000");
    expect(photonProjectSlug("***", "ffffff")).toBe("openclaw-ffffff");
  });
});

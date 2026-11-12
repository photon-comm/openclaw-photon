// Photon tests cover account resolution behavior.
import { afterEach, describe, expect, it } from "vitest";
import {
  listPhotonAccountIds,
  resolveDefaultPhotonAccountId,
  resolvePhotonAccount,
  type CoreConfig,
} from "./types.js";

const ENV_KEYS = ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("photon account resolution", () => {
  it("resolves a configured account from config", () => {
    delete process.env.PHOTON_PROJECT_ID;
    delete process.env.PHOTON_PROJECT_SECRET;
    const cfg = {
      channels: {
        photon: {
          projectId: "proj-123",
          projectSecret: "secret-abc",
        },
      },
    } as CoreConfig;

    const account = resolvePhotonAccount({ cfg });
    expect(account.accountId).toBe("default");
    expect(account.configured).toBe(true);
    expect(account.projectId).toBe("proj-123");
    expect(account.projectSecret).toBe("secret-abc");
    expect(listPhotonAccountIds(cfg)).toEqual(["default"]);
    expect(resolveDefaultPhotonAccountId(cfg)).toBe("default");
  });

  it("falls back to env credentials for the default account", () => {
    process.env.PHOTON_PROJECT_ID = "env-proj";
    process.env.PHOTON_PROJECT_SECRET = "env-secret";

    const account = resolvePhotonAccount({ cfg: {} as CoreConfig });
    expect(account.configured).toBe(true);
    expect(account.projectId).toBe("env-proj");
    expect(account.projectSecret).toBe("env-secret");
  });

  it("reports unconfigured when credentials are missing", () => {
    delete process.env.PHOTON_PROJECT_ID;
    delete process.env.PHOTON_PROJECT_SECRET;

    const account = resolvePhotonAccount({
      cfg: { channels: { photon: { projectId: "only-id" } } } as CoreConfig,
    });
    expect(account.configured).toBe(false);
    expect(account.enabled).toBe(true);
  });

  it("respects enabled=false", () => {
    const account = resolvePhotonAccount({
      cfg: {
        channels: {
          photon: { enabled: false, projectId: "p", projectSecret: "s" },
        },
      } as CoreConfig,
    });
    expect(account.enabled).toBe(false);
    expect(account.configured).toBe(true);
  });
});

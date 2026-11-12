// Photon tests cover account resolution behavior.
import { afterEach, describe, expect, it } from "vitest";
import {
  listPhotonAccountIds,
  resolveDefaultPhotonAccountId,
  resolvePhotonAccount,
  type CoreConfig,
} from "./types.js";

const ENV_KEYS = ["PHOTON_PROJECT_ID", "PHOTON_API_KEY"] as const;
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
    delete process.env.PHOTON_API_KEY;
    const cfg = {
      channels: {
        photon: {
          projectId: "proj-123",
          apiKey: "pho_sk_abc",
        },
      },
    } as CoreConfig;

    const account = resolvePhotonAccount({ cfg });
    expect(account.accountId).toBe("default");
    expect(account.configured).toBe(true);
    expect(account.projectId).toBe("proj-123");
    expect(account.apiKey).toBe("pho_sk_abc");
    expect(account.legacyStableConfig).toBe(false);
    expect(listPhotonAccountIds(cfg)).toEqual(["default"]);
    expect(resolveDefaultPhotonAccountId(cfg)).toBe("default");
  });

  it("falls back to env credentials for the default account", () => {
    process.env.PHOTON_PROJECT_ID = "env-proj";
    process.env.PHOTON_API_KEY = "env-key";

    const account = resolvePhotonAccount({ cfg: {} as CoreConfig });
    expect(account.configured).toBe(true);
    expect(account.projectId).toBe("env-proj");
    expect(account.apiKey).toBe("env-key");
  });

  it("reports unconfigured when credentials are missing", () => {
    delete process.env.PHOTON_PROJECT_ID;
    delete process.env.PHOTON_API_KEY;

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
          photon: { enabled: false, projectId: "p", apiKey: "k" },
        },
      } as CoreConfig,
    });
    expect(account.enabled).toBe(false);
    expect(account.configured).toBe(true);
  });

  it("lists env-backed credentials under the default account id", () => {
    process.env.PHOTON_PROJECT_ID = "proj-env";
    process.env.PHOTON_API_KEY = "key-env";
    const cfg = { channels: { photon: { defaultAccount: "work" } } } as CoreConfig;

    expect(listPhotonAccountIds(cfg)).toEqual(["default"]);
    const account = resolvePhotonAccount({ cfg, accountId: listPhotonAccountIds(cfg)[0] });
    expect(account.configured).toBe(true);
  });

  it("flags a v0.1 Stable config (project secret, no API key)", () => {
    delete process.env.PHOTON_PROJECT_ID;
    delete process.env.PHOTON_API_KEY;
    const account = resolvePhotonAccount({
      cfg: { channels: { photon: { projectId: "spectrum-id", projectSecret: "old" } } } as CoreConfig,
    });
    expect(account.configured).toBe(false);
    expect(account.legacyStableConfig).toBe(true);
  });
});

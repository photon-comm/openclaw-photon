// Photon plugin module implements probe behavior.
import { cloud } from "@spectrum-ts/core";
import { resolvePhotonAccount, type CoreConfig } from "./types.js";

export type PhotonProbe = {
  ok: boolean;
  projectId: string;
  projectName?: string;
  latencyMs?: number;
  error?: string;
};

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

export async function probePhoton(
  cfg: CoreConfig,
  opts?: { accountId?: string; timeoutMs?: number },
): Promise<PhotonProbe> {
  const account = resolvePhotonAccount({ cfg, accountId: opts?.accountId });
  const base: PhotonProbe = { ok: false, projectId: account.projectId };
  if (!account.configured) {
    return { ...base, error: "missing projectId or projectSecret" };
  }

  const timeoutMs = opts?.timeoutMs ?? 8000;
  const started = Date.now();
  try {
    const project = await Promise.race([
      cloud.getProject(account.projectId, account.projectSecret),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`probe timeout after ${timeoutMs}ms`)),
          timeoutMs,
        ).unref?.();
      }),
    ]);
    return {
      ...base,
      ok: true,
      projectName: project.name,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { ...base, error: formatError(err) };
  }
}

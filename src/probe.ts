// Status probe: can the API key read its project?
import { describePhotonError, PhotonProjectApi } from "./api.js";
import { resolvePhotonAccount, type CoreConfig } from "./types.js";

export type PhotonProbe = {
  ok: boolean;
  projectId: string;
  projectName?: string;
  latencyMs?: number;
  error?: string;
};

export async function probePhoton(
  cfg: CoreConfig,
  opts?: { accountId?: string; timeoutMs?: number },
): Promise<PhotonProbe> {
  const account = resolvePhotonAccount({ cfg, accountId: opts?.accountId });
  const base: PhotonProbe = { ok: false, projectId: account.projectId };
  if (!account.configured) {
    return { ...base, error: "missing projectId or apiKey" };
  }

  const timeoutMs = opts?.timeoutMs ?? 8000;
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const api = new PhotonProjectApi(account.projectId, account.apiKey);
    const project = await Promise.race([
      api.getProject(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return { ...base, ok: true, projectName: project.name, latencyMs: Date.now() - started };
  } catch (err) {
    return { ...base, error: describePhotonError(err) };
  } finally {
    clearTimeout(timer);
  }
}

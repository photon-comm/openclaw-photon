// Photon plugin module implements probe behavior.
import { cloud } from "@spectrum-ts/core";
import { resolvePhotonAccount } from "./types.js";
function formatError(err) {
    if (err instanceof Error) {
        return err.message;
    }
    return typeof err === "string" ? err : JSON.stringify(err);
}
export async function probePhoton(cfg, opts) {
    const account = resolvePhotonAccount({ cfg, accountId: opts?.accountId });
    const base = { ok: false, projectId: account.projectId };
    if (!account.configured) {
        return { ...base, error: "missing projectId or projectSecret" };
    }
    const timeoutMs = opts?.timeoutMs ?? 8000;
    const started = Date.now();
    try {
        const project = await Promise.race([
            cloud.getProject(account.projectId, account.projectSecret),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs).unref?.();
            }),
        ]);
        return {
            ...base,
            ok: true,
            projectName: project.name,
            latencyMs: Date.now() - started,
        };
    }
    catch (err) {
        return { ...base, error: formatError(err) };
    }
}

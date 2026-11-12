// Gateway lifecycle for one Photon account: open the Spectrum stream and keep
// it running until OpenClaw aborts the account task.
import { createAccountStatusSink, runPassiveAccountLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import type { RuntimeEnv } from "./runtime-api.js";
import type { CoreConfig, ResolvedPhotonAccount } from "./types.js";

type PhotonChannelRuntimeModule = typeof import("./channel-runtime.js");

let photonChannelRuntimePromise: Promise<PhotonChannelRuntimeModule> | undefined;

/** Load the Spectrum-backed runtime lazily so cold plugin loads stay light. */
export async function loadPhotonChannelRuntime(): Promise<PhotonChannelRuntimeModule> {
  photonChannelRuntimePromise ??= import("./channel-runtime.js");
  return await photonChannelRuntimePromise;
}

export async function startPhotonGatewayAccount(ctx: {
  cfg: CoreConfig;
  accountId: string;
  account: ResolvedPhotonAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  setStatus: (next: ChannelAccountSnapshot) => void;
  log?: {
    info?: (message: string) => void;
  };
}): Promise<void> {
  const account = ctx.account;
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });
  if (!account.configured) {
    throw new Error(
      `Photon is not configured for account "${account.accountId}" (set channels.photon.projectId and projectSecret, or run: openclaw channels add --channel photon).`,
    );
  }
  ctx.log?.info?.(`[${account.accountId}] starting Photon provider (project ${account.projectId})`);
  const { monitorPhotonProvider } = await loadPhotonChannelRuntime();
  await runPassiveAccountLifecycle({
    abortSignal: ctx.abortSignal,
    start: async () =>
      await monitorPhotonProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink,
      }),
    stop: (handle) => handle.stop(),
  });
}

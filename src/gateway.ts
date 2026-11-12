// Gateway lifecycle for one Photon account: open the Photon event stream and
// keep it running until OpenClaw aborts the account task.
import { createAccountStatusSink, runPassiveAccountLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import type { RuntimeEnv } from "./runtime-api.js";
import type { CoreConfig, ResolvedPhotonAccount } from "./types.js";

type PhotonChannelRuntimeModule = typeof import("./channel-runtime.js");

let photonChannelRuntimePromise: Promise<PhotonChannelRuntimeModule> | undefined;

/** Load the API client and Socket.IO runtime lazily so cold plugin loads stay light. */
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
    if (account.legacyStableConfig) {
      throw new Error(
        `Photon account "${account.accountId}" has a Stable (Spectrum) project secret, which this version doesn't use: it runs on Photon Beta. Run \`openclaw configure --section channels\` to sign in again, or install v0.1.1 to stay on Stable.`,
      );
    }
    throw new Error(
      `Photon is not configured for account "${account.accountId}" (set channels.photon.projectId and apiKey, or run: openclaw configure --section channels).`,
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

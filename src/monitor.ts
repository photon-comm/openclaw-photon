// Gateway side of one Photon account: subscribe to the project's events,
// turn each inbound iMessage into an agent turn, and keep the cursor so a
// restart picks up where it stopped.
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { describePhotonError, photonApiOrigin } from "./api.js";
import { clearActivePhotonClient, PhotonClient, setActivePhotonClient } from "./client.js";
import { subscribePhotonEvents, type PhotonDeliveryMeta, type PhotonEvent } from "./events.js";
import { handlePhotonInbound } from "./inbound.js";
import { parsePhotonInbound, type PhotonInboundEvent } from "./message.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { getPhotonRuntime } from "./runtime.js";
import { CursorTracker, photonStateFile } from "./state.js";
import { resolvePhotonAccount, type CoreConfig, type PhotonInboundMedia } from "./types.js";

type PhotonMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export const DEFAULT_MEDIA_MAX_MB = 20;

async function stageAttachments(
  client: PhotonClient,
  inbound: PhotonInboundEvent,
  params: { maxBytes: number; log: (message: string) => void },
): Promise<{ media: PhotonInboundMedia[]; placeholders: string[] }> {
  const media: PhotonInboundMedia[] = [];
  const placeholders: string[] = [];
  for (const item of inbound.attachments) {
    const label = item.kind === "voice" ? "voice note" : "attachment";
    try {
      const size = await client.api.attachmentSize(item.attachmentId);
      if (typeof size === "number" && size > params.maxBytes) {
        placeholders.push(`[Photon ${label} received: too large to read (${size} bytes)]`);
        continue;
      }
      const file = await client.api.downloadAttachment(item.attachmentId);
      const saved = await saveMediaBuffer(
        file.buffer,
        file.contentType,
        "inbound",
        params.maxBytes,
        file.fileName,
      );
      media.push({ path: saved.path, contentType: saved.contentType });
    } catch (err) {
      params.log(`photon: could not read ${label} ${item.attachmentId}: ${describePhotonError(err)}`);
      placeholders.push(`[Photon ${label} received: ${item.attachmentId}]`);
    }
  }
  for (const type of inbound.unsupported) {
    placeholders.push(`[Photon message of type ${type} received]`);
  }
  return { media, placeholders };
}

export async function monitorPhotonProvider(
  opts: PhotonMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getPhotonRuntime();
  const cfg = opts.config ?? (core.config.current() as CoreConfig);
  const account = resolvePhotonAccount({ cfg, accountId: opts.accountId });
  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.configured) {
    throw new Error(
      `Photon is not configured for account "${account.accountId}" (need projectId and apiKey in channels.photon).`,
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "photon",
    accountId: account.accountId,
  });
  const logVerbose = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      logger.debug?.(message);
    }
  };

  const client = new PhotonClient({
    accountId: account.accountId,
    projectId: account.projectId,
    apiKey: account.apiKey,
    stateFile: photonStateFile(resolveStateDir(), account.accountId),
    onStateError: (err) => {
      logger.error(`[${account.accountId}] photon: could not save state: ${String(err)}`);
    },
  });
  // Fail fast on a wrong key or project instead of retrying the socket forever.
  const project = await client.api.getProject();
  setActivePhotonClient(account.accountId, client);

  const maxBytes = Math.max(account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB, 1) * 1024 * 1024;
  const tracker = new CursorTracker(client.state.getCursor());
  // Messages being handled, by id, with the promise that settles when done.
  const inflight = new Map<string, Promise<void>>();
  let stopped = false;

  const handleInbound = async (inbound: PhotonInboundEvent) => {
    if (!inbound.direct) {
      logVerbose(
        `[${account.accountId}] photon: ignoring group message ${inbound.messageId} (group chats unsupported)`,
      );
      return;
    }
    client.rememberConversation(inbound.handle, {
      spaceId: inbound.spaceId,
      agentUserId: inbound.agentUserId,
      agentHandle: inbound.agentHandle,
    });
    const staged = await stageAttachments(client, inbound, {
      maxBytes,
      log: (message) => logger.error(`[${account.accountId}] ${message}`),
    });
    core.channel.activity.record({
      channel: "photon",
      accountId: account.accountId,
      direction: "inbound",
    });
    await handlePhotonInbound({
      message: {
        messageId: inbound.messageId,
        senderId: inbound.handle,
        text: inbound.text,
        media: staged.media,
        mediaPlaceholders: staged.placeholders,
        timestamp: inbound.timestamp,
      },
      account,
      config: cfg,
      runtime,
      statusSink: opts.statusSink,
    });
  };

  // Each conversation runs in order, but one long agent turn must not hold up
  // other senders or their pairing replies.
  const spaceQueues = new Map<string, Promise<void>>();
  const onEvent = (event: PhotonEvent, meta: PhotonDeliveryMeta) => {
    const seq = typeof meta.seq === "number" ? meta.seq : undefined;
    // A replay of a delivery that is still being handled isn't tracked twice.
    const tracked = seq !== undefined && tracker.start(seq);
    const finish = () => {
      if (!tracked || seq === undefined || stopped) {
        return;
      }
      const advanced = tracker.finish(seq);
      if (advanced !== undefined) {
        client.state.setCursor(advanced);
      }
    };
    const inbound = parsePhotonInbound(event);
    if (!inbound || client.state.hasSeen(inbound.messageId)) {
      finish();
      return;
    }
    const running = inflight.get(inbound.messageId);
    if (running) {
      // Redelivered while its first delivery is still running: that one
      // finishes it, and this sequence only moves on once it has.
      void running.then(finish);
      return;
    }
    const key = inbound.spaceId;
    const previous = spaceQueues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => (stopped ? undefined : handleInbound(inbound)))
      .catch((err: unknown) => {
        logger.error(
          `[${account.accountId}] photon inbound handler failed for ${inbound.messageId}: ${describePhotonError(err)}`,
        );
      })
      .finally(() => {
        inflight.delete(inbound.messageId);
        // Only a handled message counts as seen, so one cut off by a restart
        // is delivered again.
        if (!stopped) {
          client.state.markSeen(inbound.messageId);
          client.state.save();
        }
        finish();
        if (spaceQueues.get(key) === next) {
          spaceQueues.delete(key);
        }
      });
    inflight.set(inbound.messageId, next);
    spaceQueues.set(key, next);
  };

  const subscription = subscribePhotonEvents({
    origin: photonApiOrigin(),
    projectId: account.projectId,
    apiKey: account.apiKey,
    cursor: () => client.state.getCursor(),
    onEvent,
    // On a first start (cursor 0), keep the cursor Photon accepted, so a
    // disconnect before the first message doesn't skip the time offline.
    onSubscribed: (acceptedSeq) => {
      if (client.state.getCursor() === 0 && acceptedSeq > 0) {
        client.state.setCursor(acceptedSeq);
      }
    },
    log: (message) => logger.info(`[${account.accountId}] ${message}`),
  });

  logger.info(
    `[${account.accountId}] photon connected (project ${project.name}, ${account.projectId}, cursor ${client.state.getCursor()})`,
  );

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    subscription.stop();
    clearActivePhotonClient(account.accountId, client);
  };
  opts.abortSignal?.addEventListener("abort", stop, { once: true });
  return { stop };
}

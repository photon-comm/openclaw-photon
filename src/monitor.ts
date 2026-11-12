// Photon plugin module implements monitor behavior.
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  clearActivePhotonClient,
  normalizePhotonContent,
  PhotonClient,
  readPhotonReactionContent,
  setActivePhotonClient,
  type PhotonInboundAttachment,
  type PhotonSpace,
  type PhotonSpectrumMessage,
} from "./client.js";
import { handlePhotonInbound, handlePhotonReaction } from "./inbound.js";
import { phoneTargetFromSpaceId } from "./normalize.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { getPhotonRuntime } from "./runtime.js";
import { resolvePhotonAccount, type CoreConfig, type PhotonInboundMedia } from "./types.js";

type PhotonMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const DEFAULT_MEDIA_MAX_MB = 20;
// Spectrum gRPC reconnects can replay recent messages; a bounded seen-id set
// keeps a catch-up burst from dispatching duplicate agent turns.
const MAX_SEEN_MESSAGE_IDS = 1024;
const RESUBSCRIBE_BACKOFF_MAX_MS = 30_000;

function rememberSeenMessageId(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) {
    return false;
  }
  seen.add(id);
  if (seen.size > MAX_SEEN_MESSAGE_IDS) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) {
      seen.delete(oldest);
    }
  }
  return true;
}

async function stagePhotonAttachments(
  attachments: PhotonInboundAttachment[],
  params: { maxBytes: number; logVerbose: (message: string) => void },
): Promise<{ media: PhotonInboundMedia[]; placeholders: string[] }> {
  const media: PhotonInboundMedia[] = [];
  const placeholders: string[] = [];
  for (const item of attachments) {
    if (!item.buffer) {
      if (item.placeholder) {
        placeholders.push(item.placeholder);
      }
      continue;
    }
    try {
      const saved = await saveMediaBuffer(
        item.buffer,
        item.mimeType,
        "inbound",
        params.maxBytes,
        item.name,
      );
      media.push({ path: saved.path, contentType: saved.contentType });
    } catch (err) {
      params.logVerbose(`photon: failed to stage inbound media: ${String(err)}`);
      placeholders.push(
        `[Photon ${item.kind === "voice" ? "voice note" : "attachment"} received: ${item.name ?? "(unnamed)"}]`,
      );
    }
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
      `Photon is not configured for account "${account.accountId}" (need projectId and projectSecret in channels.photon).`,
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

  const client = await PhotonClient.connect({
    projectId: account.projectId,
    projectSecret: account.projectSecret,
  });
  setActivePhotonClient(account.accountId, client);

  const maxBytes = Math.max(account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB, 1) * 1024 * 1024;
  const seenMessageIds = new Set<string>();
  let stopped = false;

  const handleEvent = async (space: PhotonSpace, message: PhotonSpectrumMessage) => {
    // Skip our own outbound echoes.
    if (message.direction && message.direction !== "inbound") {
      return;
    }
    if (!message.id || !rememberSeenMessageId(seenMessageIds, message.id)) {
      return;
    }
    // Photon does not support group chats; only DM spaces dispatch.
    if (space.type === "group") {
      logVerbose(
        `[${account.accountId}] photon: ignoring group-space message ${message.id} (groups unsupported)`,
      );
      return;
    }
    client.rememberSpace(space);
    // Keep the live handle so status tapbacks can react to this message.
    client.rememberMessage(message);

    const spacePhone = space.phone ?? phoneTargetFromSpaceId(space.id) ?? undefined;
    const senderId = message.sender?.id ?? spacePhone ?? "";
    if (!senderId) {
      logVerbose(`[${account.accountId}] photon: dropping message ${message.id} without sender`);
      return;
    }
    const timestamp = message.timestamp instanceof Date ? message.timestamp.getTime() : Date.now();

    const reactionFacts = readPhotonReactionContent(message.content);
    if (reactionFacts) {
      // Only tapbacks on the agent's own messages reach the agent; provider
      // hydration of target.direction wins, sent-id cache covers the rest.
      const targetsOwnMessage =
        reactionFacts.targetDirection === "outbound" ||
        client.isOwnMessageId(reactionFacts.targetMessageId);
      if (!targetsOwnMessage) {
        logVerbose(
          `[${account.accountId}] photon: ignoring reaction on non-agent message ${reactionFacts.targetMessageId ?? "(unknown)"}`,
        );
        return;
      }
      await handlePhotonReaction({
        reaction: {
          messageId: message.id,
          spaceId: space.id,
          spacePhone,
          senderId,
          emoji: reactionFacts.emoji,
          targetMessageId: reactionFacts.targetMessageId,
          timestamp,
        },
        account,
        config: cfg,
        runtime,
      });
      return;
    }

    const normalized = await normalizePhotonContent(message.content, {
      maxBytes,
      onReadError: (err) => {
        logger.error(`[${account.accountId}] photon media read failed: ${String(err)}`);
      },
    });
    if (!normalized) {
      logVerbose(
        `[${account.accountId}] photon: ignoring inbound content type ${message.content.type}`,
      );
      return;
    }

    const staged = await stagePhotonAttachments(normalized.attachments, {
      maxBytes,
      logVerbose,
    });

    core.channel.activity.record({
      channel: "photon",
      accountId: account.accountId,
      direction: "inbound",
    });

    await handlePhotonInbound({
      message: {
        messageId: message.id,
        spaceId: space.id,
        spacePhone,
        senderId,
        text: normalized.text,
        media: staged.media,
        mediaPlaceholders: staged.placeholders,
        timestamp,
      },
      account,
      config: cfg,
      runtime,
      statusSink: opts.statusSink,
    });
  };

  // spectrum-ts reconnects gRPC internally, but if the message iterator itself
  // throws or ends this consumer would stop forever. Re-subscribe with capped
  // backoff plus jitter; the seen-id set absorbs any catch-up replay.
  void (async () => {
    let backoff = 1000;
    for (;;) {
      if (stopped || opts.abortSignal?.aborted) {
        break;
      }
      try {
        for await (const [space, message] of client.messages) {
          if (stopped || opts.abortSignal?.aborted) {
            break;
          }
          backoff = 1000;
          try {
            await handleEvent(space, message);
          } catch (err) {
            logger.error(`[${account.accountId}] photon inbound handler failed: ${String(err)}`);
          }
        }
        if (!stopped) {
          logger.info(`[${account.accountId}] photon inbound stream ended; re-subscribing`);
        }
      } catch (err) {
        if (!stopped) {
          logger.error(
            `[${account.accountId}] photon inbound stream errored; restarting: ${String(err)}`,
          );
        }
      }
      if (stopped || opts.abortSignal?.aborted) {
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, backoff + Math.random() * backoff * 0.2);
      });
      backoff = Math.min(backoff * 2, RESUBSCRIBE_BACKOFF_MAX_MS);
    }
  })();

  logger.info(`[${account.accountId}] photon connected (project ${account.projectId})`);

  return {
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearActivePhotonClient(account.accountId, client);
      void client.stop().catch((err: unknown) => {
        logger.error(`[${account.accountId}] photon stop failed: ${String(err)}`);
      });
    },
  };
}

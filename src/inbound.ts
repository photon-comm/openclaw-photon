// Photon plugin module implements inbound behavior.
import {
  buildChannelInboundEventContext,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { getActivePhotonClient } from "./client.js";
import { normalizePhotonAllowEntry, normalizePhotonSenderId } from "./normalize.js";
import { getPhotonRuntime } from "./runtime.js";
import { sendMessagePhoton } from "./send.js";
import type {
  CoreConfig,
  PhotonInboundMessage,
  PhotonInboundReaction,
  ResolvedPhotonAccount,
} from "./types.js";

const CHANNEL_ID = "photon" as const;

/** Injectable side effects so tests stay safe under shared module registries. */
export type PhotonInboundDeps = {
  sendMessage?: typeof sendMessagePhoton;
  enqueueSystemEvent?: typeof enqueueSystemEvent;
};
// Processing-status tapbacks, hermes-style: 👀 while the agent works, then
// 👍/👎. iMessage keeps one tapback per sender, so each react replaces the
// previous one.
const REACTION_PROCESSING = "👀";
const REACTION_DONE = "👍";
const REACTION_ERROR = "👎";

const photonIngressIdentity = defineStableChannelIngressIdentity({
  key: "photon-phone",
  normalizeEntry: (raw) => normalizePhotonAllowEntry(raw) || null,
  normalizeSubject: (raw) => normalizePhotonSenderId(raw) || null,
  sensitivity: "pii",
  entryIdPrefix: "photon-entry",
  isWildcardEntry: (entry) => normalizePhotonAllowEntry(entry) === "*",
});

async function deliverPhotonReply(params: {
  payload: OutboundReplyPayload;
  cfg: CoreConfig;
  target: string;
  accountId: string;
  sendMessage: typeof sendMessagePhoton;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const text = params.payload.text?.trim() ?? "";
  const mediaUrls = normalizeStringEntries(
    params.payload.mediaUrls ?? (params.payload.mediaUrl ? [params.payload.mediaUrl] : []),
  );
  if (!text && mediaUrls.length === 0) {
    return;
  }
  // First media carries the text as its caption (Photon renders the caption
  // as a follow-up bubble); remaining media and text-only replies send alone.
  if (mediaUrls.length > 0) {
    for (const [index, mediaUrl] of mediaUrls.entries()) {
      await params.sendMessage(params.target, index === 0 ? text : "", {
        cfg: params.cfg,
        accountId: params.accountId,
        mediaUrl,
      });
    }
  } else {
    await params.sendMessage(params.target, text, {
      cfg: params.cfg,
      accountId: params.accountId,
    });
  }
  params.statusSink?.({ lastOutboundAt: Date.now() });
}

function createStatusTapback(params: {
  enabled: boolean;
  accountId: string;
  messageId: string;
  runtime: RuntimeEnv;
}) {
  const react = async (emoji: string) => {
    if (!params.enabled) {
      return;
    }
    try {
      const client = getActivePhotonClient(params.accountId);
      const reacted = await client?.react(params.messageId, emoji);
      if (!reacted) {
        params.runtime.log?.(`photon: tapback skipped (no live handle for ${params.messageId})`);
      }
    } catch (err) {
      params.runtime.log?.(`photon: tapback ${emoji} failed: ${String(err)}`);
    }
  };
  return {
    processing: () => react(REACTION_PROCESSING),
    done: () => react(REACTION_DONE),
    error: () => react(REACTION_ERROR),
  };
}

export async function handlePhotonInbound(params: {
  message: PhotonInboundMessage;
  account: ResolvedPhotonAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  deps?: PhotonInboundDeps;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const sendMessage = params.deps?.sendMessage ?? sendMessagePhoton;
  const core = getPhotonRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = [message.text.trim(), ...message.mediaPlaceholders]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!rawBody && message.media.length === 0) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderId = normalizePhotonSenderId(message.senderId);
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);

  const access = await createChannelIngressResolver({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    identity: photonIngressIdentity,
    cfg: config as OpenClawConfig,
    readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
  }).message({
    subject: { stableId: senderId },
    conversation: {
      kind: "direct",
      id: senderId,
    },
    dmPolicy,
    allowFrom: account.config.allowFrom,
    command: {
      allowTextCommands,
      hasControlCommand,
    },
  });

  const replyTarget = message.spacePhone ?? message.spaceId;

  if (access.ingress.admission === "pairing-required") {
    await pairing.issueChallenge({
      senderId,
      senderIdLine: `Your Photon sender id: ${senderId}`,
      sendPairingReply: async (text) => {
        await deliverPhotonReply({
          payload: { text },
          cfg: config,
          target: replyTarget,
          accountId: account.accountId,
          sendMessage,
          statusSink,
        });
      },
      onReplyError: (err) => {
        runtime.error?.(`photon: pairing reply failed for ${senderId}: ${String(err)}`);
      },
    });
    runtime.log?.(`photon: drop DM sender ${senderId} (dmPolicy=${dmPolicy})`);
    return;
  }
  if (access.ingress.admission !== "dispatch") {
    runtime.log?.(`photon: drop DM sender ${senderId} (dmPolicy=${dmPolicy})`);
    return;
  }

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: senderId,
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  const { storePath, body } = buildEnvelope({
    channel: "Photon",
    from: senderId,
    timestamp: message.timestamp,
    body: rawBody,
  });

  const ctxPayload = buildChannelInboundEventContext({
    channel: CHANNEL_ID,
    accountId: route.accountId,
    messageId: message.messageId,
    timestamp: message.timestamp,
    from: `photon:${senderId}`,
    sender: {
      id: senderId,
    },
    conversation: {
      kind: "direct",
      id: senderId,
      label: senderId,
    },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: `photon:${replyTarget}`,
    },
    message: {
      body,
      rawBody,
      commandBody: rawBody,
    },
    access: {
      commands: access.commandAccess.requested
        ? { authorized: access.commandAccess.authorized }
        : undefined,
    },
    media: toInboundMediaFacts(
      message.media.map((item) => ({
        path: item.path,
        url: item.path,
        contentType: item.contentType,
      })),
    ),
  });

  const tapback = createStatusTapback({
    enabled: account.config.reactions === true,
    accountId: account.accountId,
    messageId: message.messageId,
    runtime,
  });
  await tapback.processing();
  let deliveryFailed = false;

  try {
    await core.channel.inbound.dispatchReply({
      cfg: config as OpenClawConfig,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      storePath,
      ctxPayload,
      recordInboundSession: core.channel.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher:
        core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        deliver: async (payload) => {
          await deliverPhotonReply({
            payload,
            cfg: config,
            target: replyTarget,
            accountId: account.accountId,
            sendMessage,
            statusSink,
          });
        },
        onError: (err, info) => {
          deliveryFailed = true;
          runtime.error?.(`photon ${info.kind} reply failed: ${String(err)}`);
        },
      },
      // Native iMessage typing bubble while the agent works; the shared
      // pipeline owns keepalive and teardown on final/error/abort.
      replyPipeline: {
        typing: {
          start: async () => {
            const client = getActivePhotonClient(account.accountId);
            await client?.setTyping(replyTarget, "start");
          },
          stop: async () => {
            const client = getActivePhotonClient(account.accountId);
            await client?.setTyping(replyTarget, "stop");
          },
          onStartError: (err) => {
            runtime.log?.(`photon: typing start failed: ${String(err)}`);
          },
          onStopError: (err) => {
            runtime.log?.(`photon: typing stop failed: ${String(err)}`);
          },
        },
      },
      replyOptions: {
        disableBlockStreaming:
          typeof account.config.blockStreaming === "boolean"
            ? !account.config.blockStreaming
            : undefined,
      },
      record: {
        onRecordError: (err) => {
          runtime.error?.(`photon: failed updating session meta: ${String(err)}`);
        },
      },
    });
  } catch (err) {
    await tapback.error();
    throw err;
  }
  await (deliveryFailed ? tapback.error() : tapback.done());
}

/**
 * Route a tapback on one of the agent's own messages to the agent as a
 * system event (hermes parity: `reaction added: <emoji>`). Gated on the
 * `reactions` config flag and the DM sender allow gate; pairing challenges
 * are never issued for reactions.
 */
export async function handlePhotonReaction(params: {
  reaction: PhotonInboundReaction;
  account: ResolvedPhotonAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  deps?: PhotonInboundDeps;
}): Promise<void> {
  const { reaction, account, config, runtime } = params;
  const enqueue = params.deps?.enqueueSystemEvent ?? enqueueSystemEvent;
  if (account.config.reactions !== true) {
    return;
  }
  const core = getPhotonRuntime();
  const senderId = normalizePhotonSenderId(reaction.senderId);
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const access = await createChannelIngressResolver({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    identity: photonIngressIdentity,
    cfg: config as OpenClawConfig,
    readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
  }).event({
    subject: { stableId: senderId },
    conversation: {
      kind: "direct",
      id: senderId,
    },
    dmPolicy: account.config.dmPolicy ?? "pairing",
    allowFrom: account.config.allowFrom,
  });
  if (access.senderAccess.decision !== "allow") {
    runtime.log?.(`photon: drop reaction from ${senderId} (${access.senderAccess.reasonCode})`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: senderId,
    },
  });
  const target = reaction.targetMessageId ? `msg ${reaction.targetMessageId}` : "a message";
  const text = `Photon reaction added: ${reaction.emoji} by ${senderId} on ${target}`;
  const contextKey = [
    "photon",
    "reaction",
    senderId,
    reaction.targetMessageId ?? reaction.messageId,
    reaction.emoji,
  ].join(":");
  const queued = enqueue(text, {
    sessionKey: route.sessionKey,
    contextKey,
  });
  runtime.log?.(
    `photon: reaction system event ${queued ? "queued" : "deduped"} session=${route.sessionKey} emoji=${reaction.emoji}`,
  );
}

// Photon plugin module implements inbound behavior.
import {
  buildChannelInboundEventContext,
  createChannelInboundEnvelopeBuilderAsync,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-local-roots";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describePhotonError } from "./api.js";
import { getActivePhotonClient } from "./client.js";
import { normalizePhotonAllowEntry, normalizePhotonSenderId } from "./normalize.js";
import { getPhotonRuntime } from "./runtime.js";
import { sendMessagePhoton } from "./send.js";
import type { CoreConfig, PhotonInboundMessage, ResolvedPhotonAccount } from "./types.js";

const CHANNEL_ID = "photon" as const;

/** Injectable side effects so tests stay safe under shared module registries. */
export type PhotonInboundDeps = {
  sendMessage?: typeof sendMessagePhoton;
};

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
  mediaLocalRoots?: readonly string[];
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const text = params.payload.text?.trim() ?? "";
  const mediaUrls = normalizeStringEntries(
    params.payload.mediaUrls ?? (params.payload.mediaUrl ? [params.payload.mediaUrl] : []),
  );
  if (!text && mediaUrls.length === 0) {
    return;
  }
  // First media carries the text as its caption (sent as a bubble after the
  // image); remaining media and text-only replies send alone.
  if (mediaUrls.length > 0) {
    for (const [index, mediaUrl] of mediaUrls.entries()) {
      await params.sendMessage(params.target, index === 0 ? text : "", {
        cfg: params.cfg,
        accountId: params.accountId,
        mediaUrl,
        mediaLocalRoots: params.mediaLocalRoots,
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

  // Replies go back to the sender's handle; the client already knows the DM
  // it arrived in.
  const replyTarget = message.senderId;

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

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: senderId,
    },
  });
  const storePath = resolveStorePath(config.session?.store, { agentId: route.agentId });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(config as OpenClawConfig, route.agentId);
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({
    cfg: config as OpenClawConfig,
    route,
  });
  const body = buildEnvelope({
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

  const client = getActivePhotonClient(account.accountId);
  // The agent has picked the message up: show it as read.
  await client?.markRead(message.messageId).catch((err: unknown) => {
    runtime.log?.(`photon: read receipt failed: ${describePhotonError(err)}`);
  });
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
          mediaLocalRoots,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`photon ${info.kind} reply failed: ${describePhotonError(err)}`);
      },
    },
    // iMessage typing bubble while the agent works; the shared pipeline
    // owns keepalive and teardown on final/error/abort.
    replyPipeline: {
      typing: {
        start: async () => {
          await getActivePhotonClient(account.accountId)?.setTyping(replyTarget, true);
        },
        stop: async () => {
          await getActivePhotonClient(account.accountId)?.setTyping(replyTarget, false);
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
}

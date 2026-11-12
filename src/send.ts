// Outbound sends: agent replies, `openclaw message send`, pairing notices.
import { basename } from "node:path";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { stripMarkdown } from "openclaw/plugin-sdk/text-chunking";
import type { PhotonOutboundFile } from "./api.js";
import { getActivePhotonClient, PhotonClient, type PhotonSendResult } from "./client.js";
import { normalizePhotonMessagingTarget } from "./normalize.js";
import { getPhotonRuntime } from "./runtime.js";
import { resolvePhotonAccount, type CoreConfig } from "./types.js";

const DEFAULT_MEDIA_MAX_MB = 20;

export type SendPhotonOptions = {
  cfg: CoreConfig;
  accountId?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
    workspaceDir?: string;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

type SendPhotonResult = {
  messageId: string;
  /** Photon Space the message went to. */
  conversationId: string;
  target: { kind: "chat"; id: string };
  receipt: MessageReceipt;
};

function recordPhotonOutboundActivity(accountId: string): void {
  try {
    getPhotonRuntime().channel.activity.record({
      channel: "photon",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Photon runtime not initialized") {
      throw error;
    }
  }
}

/**
 * Photon Beta sends iMessage text as plain text, so Markdown is flattened:
 * tables follow the channel's markdown.tables setting, then the rest of the
 * syntax is removed.
 */
export function preparePhotonText(text: string, cfg: CoreConfig, accountId: string): string {
  let prepared = text.trim();
  if (!prepared) {
    return prepared;
  }
  try {
    const textRuntime = getPhotonRuntime().channel.text;
    const mode = textRuntime.resolveMarkdownTableMode({ cfg, channel: "photon", accountId });
    prepared = textRuntime.convertMarkdownTables(prepared, mode);
  } catch {
    // No runtime (unit tests): keep the tables as they are.
  }
  return stripMarkdown(prepared).trim();
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
};

function fileNameFor(mediaUrl: string, contentType: string, given?: string): string {
  const fromUrl = (() => {
    try {
      return basename(new URL(mediaUrl).pathname);
    } catch {
      return basename(mediaUrl);
    }
  })();
  const name = (given || fromUrl || "attachment").replace(/[^\w.-]+/g, "_").slice(-80) || "attachment";
  return /\.[A-Za-z0-9]{1,5}$/.test(name) ? name : `${name}${EXTENSIONS[contentType] ?? ""}`;
}

async function loadPhotonMedia(
  mediaUrl: string,
  opts: SendPhotonOptions,
  maxBytes: number,
): Promise<PhotonOutboundFile> {
  const loaded = await loadOutboundMediaFromUrl(mediaUrl, {
    maxBytes,
    mediaAccess: opts.mediaAccess,
    mediaLocalRoots: opts.mediaLocalRoots,
    mediaReadFile: opts.mediaReadFile,
  });
  const contentType = loaded.contentType || "application/octet-stream";
  return {
    buffer: loaded.buffer,
    contentType,
    fileName: fileNameFor(mediaUrl, contentType, loaded.fileName),
  };
}

async function withPhotonClient<T>(
  params: { accountId: string; projectId: string; apiKey: string },
  run: (client: PhotonClient) => Promise<T>,
): Promise<T> {
  // The gateway's client knows the conversations already; a one-off CLI send
  // without a running gateway looks them up.
  const client =
    getActivePhotonClient(params.accountId) ??
    new PhotonClient({
      accountId: params.accountId,
      projectId: params.projectId,
      apiKey: params.apiKey,
    });
  return await run(client);
}

export async function sendMessagePhoton(
  to: string,
  text: string,
  opts: SendPhotonOptions,
): Promise<SendPhotonResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "Photon send") as CoreConfig;
  const account = resolvePhotonAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) {
    throw new Error(
      `Photon is not configured for account "${account.accountId}" (need projectId and apiKey in channels.photon).`,
    );
  }

  const target = normalizePhotonMessagingTarget(to);
  if (!target) {
    throw new Error(`Invalid Photon target: ${to} (use a phone number like +15551234567 or an iMessage email)`);
  }

  const prepared = preparePhotonText(text, cfg, account.accountId);
  const mediaUrl = opts.mediaUrl?.trim();
  if (!prepared && !mediaUrl) {
    throw new Error("Message must include text or media for Photon sends");
  }
  const maxBytes = Math.max(account.config.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB, 1) * 1024 * 1024;

  const result: PhotonSendResult = await withPhotonClient(
    { accountId: account.accountId, projectId: account.projectId, apiKey: account.apiKey },
    async (client) => {
      if (!mediaUrl) {
        return await client.sendText(target, prepared);
      }
      const file = await loadPhotonMedia(mediaUrl, opts, maxBytes);
      const sent = await client.sendFile(target, file);
      // The caption goes after the image as its own bubble.
      if (prepared) {
        try {
          await client.sendText(target, prepared);
        } catch (err) {
          // The attachment is already delivered; failing here would invite a
          // retry that sends it twice.
          console.warn(`photon: caption send failed after media delivery: ${String(err)}`);
        }
      }
      return sent;
    },
  );

  recordPhotonOutboundActivity(account.accountId);

  const messageId = result.messageId ?? `photon-${Date.now()}`;
  return {
    messageId,
    conversationId: result.spaceId,
    target: { kind: "chat", id: target },
    receipt: createMessageReceiptFromOutboundResults({
      results: [
        {
          channel: "photon",
          messageId,
          conversationId: result.spaceId,
        },
      ],
      kind: mediaUrl ? "media" : "text",
    }),
  };
}

// Photon type declarations define plugin contracts.
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import {
  listCombinedAccountIds,
  resolveListedDefaultAccountId,
} from "openclaw/plugin-sdk/account-resolution";
import type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  MarkdownConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { normalizeSecretInputString, type SecretInput } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type PhotonAccountConfig = {
  name?: string;
  enabled?: boolean;
  defaultAccount?: string;
  /** Spectrum project id (the project's `spectrumProjectId`). */
  projectId?: string;
  /** Project secret paired with the Spectrum project id. */
  projectSecret?: SecretInput;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  /**
   * Tapback 👀/👍/👎 as processing status and route tapbacks on agent
   * messages to the agent (default false; tapbacks are real iMessages).
   */
  reactions?: boolean;
  markdown?: MarkdownConfig;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  responsePrefix?: string;
  mediaMaxMb?: number;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    photon?: PhotonAccountConfig;
  };
};

export type ResolvedPhotonAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  projectId: string;
  projectSecret: string;
  config: PhotonAccountConfig;
};

export type PhotonInboundMedia = {
  path: string;
  contentType?: string;
};

export type PhotonInboundMessage = {
  messageId: string;
  /** Spectrum DM space id (DM chat guid). */
  spaceId: string;
  /** Peer phone number (E.164) when known. */
  spacePhone?: string;
  /** Sender handle (E.164 phone or platform handle). */
  senderId: string;
  text: string;
  media: PhotonInboundMedia[];
  /** Text markers for media that could not be staged (oversize/read failure). */
  mediaPlaceholders: string[];
  timestamp: number;
};

export type PhotonInboundReaction = {
  messageId: string;
  spaceId: string;
  spacePhone?: string;
  senderId: string;
  emoji: string;
  targetMessageId?: string;
  timestamp: number;
};

function getPhotonConfig(cfg: OpenClawConfig): PhotonAccountConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.photon as
    | PhotonAccountConfig
    | undefined;
}

function resolveConfiguredDefaultPhotonAccountId(cfg: OpenClawConfig): string | undefined {
  return normalizeOptionalAccountId(getPhotonConfig(cfg)?.defaultAccount);
}

function resolveEnvProjectId(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? (process.env.PHOTON_PROJECT_ID?.trim() ?? "") : "";
}

function resolveEnvProjectSecret(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? (process.env.PHOTON_PROJECT_SECRET?.trim() ?? "") : "";
}

/** List all configured Photon account ids. */
export function listPhotonAccountIds(cfg: OpenClawConfig): string[] {
  const photonCfg = getPhotonConfig(cfg);
  const projectId = photonCfg?.projectId?.trim() || process.env.PHOTON_PROJECT_ID?.trim();
  return listCombinedAccountIds({
    configuredAccountIds: [],
    implicitAccountId: projectId
      ? (resolveConfiguredDefaultPhotonAccountId(cfg) ?? DEFAULT_ACCOUNT_ID)
      : undefined,
  });
}

/** Resolve the default Photon account id. */
export function resolveDefaultPhotonAccountId(cfg: OpenClawConfig): string {
  return resolveListedDefaultAccountId({
    accountIds: listPhotonAccountIds(cfg),
    configuredDefaultAccountId: resolveConfiguredDefaultPhotonAccountId(cfg),
  });
}

/** Resolve a Photon account from config plus default-account env fallbacks. */
export function resolvePhotonAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedPhotonAccount {
  const accountId = normalizeAccountId(opts.accountId ?? resolveDefaultPhotonAccountId(opts.cfg));
  const photonCfg = getPhotonConfig(opts.cfg);

  const enabled = photonCfg?.enabled !== false;
  const projectId = photonCfg?.projectId?.trim() || resolveEnvProjectId(accountId);
  const projectSecret =
    normalizeSecretInputString(photonCfg?.projectSecret) || resolveEnvProjectSecret(accountId);

  return {
    accountId,
    name: normalizeOptionalString(photonCfg?.name),
    enabled,
    configured: Boolean(projectId && projectSecret),
    projectId,
    projectSecret,
    config: photonCfg ?? {},
  };
}

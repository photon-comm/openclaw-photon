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
  /** Photon Beta project id (`pho_prj_...`). */
  projectId?: string;
  /** Project API key (`pho_sk_...`) with project:read, project:write and platforms:read. */
  apiKey?: SecretInput;
  /**
   * Stable (Spectrum) project secret from v0.1. Not used since v0.2, which
   * runs on Photon Beta; kept so an old config still loads and can say so.
   */
  projectSecret?: SecretInput;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  /** Tapback 👀 while the agent works, then 👍 or 👎 (default false). */
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
  apiKey: string;
  /** A v0.1 (Stable) config: a project secret and no API key. */
  legacyStableConfig: boolean;
  config: PhotonAccountConfig;
};

export type PhotonInboundMedia = {
  path: string;
  contentType?: string;
};

export type PhotonInboundMessage = {
  messageId: string;
  /** Sender handle: E.164 phone or iMessage email. Replies go back to it. */
  senderId: string;
  text: string;
  media: PhotonInboundMedia[];
  /** Text markers for media that could not be staged (oversize/read failure). */
  mediaPlaceholders: string[];
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

function resolveEnvApiKey(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? (process.env.PHOTON_API_KEY?.trim() ?? "") : "";
}

/** List all configured Photon account ids. */
export function listPhotonAccountIds(cfg: OpenClawConfig): string[] {
  const photonCfg = getPhotonConfig(cfg);
  const configProjectId = photonCfg?.projectId?.trim();
  const configSecret = normalizeSecretInputString(photonCfg?.apiKey);
  const projectId = configProjectId || process.env.PHOTON_PROJECT_ID?.trim();
  // Environment credentials only resolve for the default account, so an
  // account that leans on them must be listed under that id.
  const fullyConfigured = Boolean(configProjectId && configSecret);
  return listCombinedAccountIds({
    configuredAccountIds: [],
    implicitAccountId: projectId
      ? fullyConfigured
        ? (resolveConfiguredDefaultPhotonAccountId(cfg) ?? DEFAULT_ACCOUNT_ID)
        : DEFAULT_ACCOUNT_ID
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
  const apiKey = normalizeSecretInputString(photonCfg?.apiKey) || resolveEnvApiKey(accountId);

  return {
    accountId,
    name: normalizeOptionalString(photonCfg?.name),
    enabled,
    configured: Boolean(projectId && apiKey),
    projectId,
    apiKey,
    legacyStableConfig: !apiKey && photonCfg?.projectSecret !== undefined,
    config: photonCfg ?? {},
  };
}

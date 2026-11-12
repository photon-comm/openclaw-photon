// Photon type declarations define plugin contracts.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId, normalizeOptionalAccountId, } from "openclaw/plugin-sdk/account-id";
import { listCombinedAccountIds, resolveListedDefaultAccountId, } from "openclaw/plugin-sdk/account-resolution";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
function getPhotonConfig(cfg) {
    return cfg.channels?.photon;
}
function resolveConfiguredDefaultPhotonAccountId(cfg) {
    return normalizeOptionalAccountId(getPhotonConfig(cfg)?.defaultAccount);
}
function resolveEnvProjectId(accountId) {
    return accountId === DEFAULT_ACCOUNT_ID ? (process.env.PHOTON_PROJECT_ID?.trim() ?? "") : "";
}
function resolveEnvProjectSecret(accountId) {
    return accountId === DEFAULT_ACCOUNT_ID ? (process.env.PHOTON_PROJECT_SECRET?.trim() ?? "") : "";
}
/** List all configured Photon account ids. */
export function listPhotonAccountIds(cfg) {
    const photonCfg = getPhotonConfig(cfg);
    const configProjectId = photonCfg?.projectId?.trim();
    const configSecret = normalizeSecretInputString(photonCfg?.projectSecret);
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
export function resolveDefaultPhotonAccountId(cfg) {
    return resolveListedDefaultAccountId({
        accountIds: listPhotonAccountIds(cfg),
        configuredDefaultAccountId: resolveConfiguredDefaultPhotonAccountId(cfg),
    });
}
/** Resolve a Photon account from config plus default-account env fallbacks. */
export function resolvePhotonAccount(opts) {
    const accountId = normalizeAccountId(opts.accountId ?? resolveDefaultPhotonAccountId(opts.cfg));
    const photonCfg = getPhotonConfig(opts.cfg);
    const enabled = photonCfg?.enabled !== false;
    const projectId = photonCfg?.projectId?.trim() || resolveEnvProjectId(accountId);
    const projectSecret = normalizeSecretInputString(photonCfg?.projectSecret) || resolveEnvProjectSecret(accountId);
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

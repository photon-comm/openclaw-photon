// Setup surface for `openclaw channels add --channel photon` and
// `openclaw configure --section channels`.
import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-setup";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import type { ChannelSetupDmPolicy, ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import {
  createStandardChannelSetupStatus,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelParsedAllowFromPrompt,
  mergeAllowFromEntries,
  parseSetupEntriesWithParser,
  patchTopLevelChannelConfigSection,
} from "openclaw/plugin-sdk/setup";
import { isHandlePhotonTarget, isValidPhotonHandle, normalizePhotonAllowEntry, normalizePhotonHandle } from "./normalize.js";
import { PHOTON_DASHBOARD_URL } from "./origin.js";
import {
  createPhotonGatewayKey,
  createPhotonProject,
  DEFAULT_PHOTON_PROJECT_NAME,
  describeProvisionError,
  ensurePhotonSharedLine,
  getPhotonImessageMode,
  listPhotonDedicatedLines,
  listPhotonOrganizations,
  listPhotonProjects,
  pollPhotonDeviceToken,
  requestPhotonDeviceCode,
  waitForPhotonProject,
  type PhotonProjectSummary,
} from "./provision.js";
import { t } from "./setup-strings.js";
import { resolveDefaultPhotonAccountId, resolvePhotonAccount, type CoreConfig } from "./types.js";

const DOCS_URL = "https://github.com/photon-hq/openclaw-photon#readme";

const channel = "photon" as const;
// Set after a successful sign-in run so the manual project-id/API-key prompts
// are skipped for this wizard pass.
const DEVICE_SETUP_DONE_FLAG = "__photonDeviceSetupDone";
const CREATE_PROJECT = "__photon_create_project__";

const PHOTON_SETUP_HELP_LINES = [
  t("wizard.photon.helpDeviceLogin"),
  t("wizard.photon.helpProjectCredentials"),
  t("wizard.photon.helpEnvVars"),
  `Docs: ${DOCS_URL}`,
];

const PHOTON_ALLOW_FROM_HELP_LINES = [
  t("wizard.photon.allowlistIntro"),
  t("wizard.photon.examples"),
  "- +15551234567",
  "- you@icloud.com",
  t("wizard.photon.multipleEntries"),
  `Docs: ${DOCS_URL}`,
];

function buildPhotonSetupPatch(accountId: string, patch: Record<string, unknown>) {
  return {
    ...(accountId !== DEFAULT_ACCOUNT_ID ? { defaultAccount: accountId } : {}),
    ...patch,
  };
}

function parsePhotonAllowFrom(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesWithParser(raw, (entry) => {
    const normalized = normalizePhotonAllowEntry(entry);
    if (normalized === "*" || isHandlePhotonTarget(normalized)) {
      return { value: normalized };
    }
    return {
      error: `Invalid Photon sender (expected a phone number like +15551234567 or an iMessage email): ${entry}`,
    };
  });
}

const promptPhotonAllowFrom = createTopLevelChannelParsedAllowFromPrompt({
  channel,
  defaultAccountId: resolveDefaultPhotonAccountId,
  noteTitle: t("wizard.photon.allowlistTitle"),
  noteLines: PHOTON_ALLOW_FROM_HELP_LINES,
  message: t("wizard.photon.allowFromPrompt"),
  placeholder: "+15551234567, you@icloud.com",
  parseEntries: parsePhotonAllowFrom,
  // This prompt runs for the allowlist policy: drop a "*" left over from an
  // earlier open policy, or the allowlist would still admit everyone.
  mergeEntries: ({ existing, parsed }) =>
    mergeAllowFromEntries(
      existing.filter((entry) => normalizePhotonAllowEntry(String(entry)) !== "*"),
      parsed,
    ),
});

const photonDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
  label: "Photon",
  channel,
  policyKey: "channels.photon.dmPolicy",
  allowFromKey: "channels.photon.allowFrom",
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.photon?.dmPolicy ?? "pairing",
  promptAllowFrom: promptPhotonAllowFrom,
});

type PhotonDeviceSetupResult = {
  project: PhotonProjectSummary;
  apiKey: string;
  handle?: string;
};

async function withProgress<T>(prompter: WizardPrompter, label: string, run: () => Promise<T>): Promise<T> {
  const progress = prompter.progress(label);
  try {
    return await run();
  } finally {
    progress.stop();
  }
}

async function choosePhotonProject(
  prompter: WizardPrompter,
  token: string,
): Promise<PhotonProjectSummary> {
  const organizations = await withProgress(prompter, t("wizard.photon.loadingProjects"), () =>
    listPhotonOrganizations(token),
  );
  if (organizations.length === 0) {
    throw new Error(t("wizard.photon.noOrganization", { url: PHOTON_DASHBOARD_URL }));
  }
  const organizationId =
    organizations.length === 1
      ? organizations[0].organizationId
      : await prompter.select({
          message: t("wizard.photon.organizationPrompt"),
          options: organizations.map((org) => ({ value: org.organizationId, label: org.name })),
          initialValue: organizations[0].organizationId,
        });
  const projects = await withProgress(prompter, t("wizard.photon.loadingProjects"), () =>
    listPhotonProjects(token, organizationId),
  );
  let choice: string = CREATE_PROJECT;
  if (projects.length > 0) {
    const named = projects.find(
      (project) => project.name.toLowerCase() === DEFAULT_PHOTON_PROJECT_NAME.toLowerCase(),
    );
    choice = await prompter.select({
      message: t("wizard.photon.projectPrompt"),
      options: [
        ...projects.map((project) => ({ value: project.projectId, label: project.name, hint: project.projectId })),
        { value: CREATE_PROJECT, label: t("wizard.photon.createProjectOption", { name: DEFAULT_PHOTON_PROJECT_NAME }) },
      ],
      initialValue: named?.projectId ?? CREATE_PROJECT,
      searchable: projects.length > 8,
    });
  }
  const existing = projects.find((project) => project.projectId === choice);
  if (existing) {
    if (existing.ready === false) {
      await withProgress(prompter, t("wizard.photon.preparingProject"), () =>
        waitForPhotonProject(token, existing.projectId),
      );
    }
    return existing;
  }
  return await withProgress(prompter, t("wizard.photon.creatingProject"), () =>
    createPhotonProject(token, organizationId, DEFAULT_PHOTON_PROJECT_NAME),
  );
}

/** Give the person a line to text, and say which. Never fails the setup. */
export async function preparePhotonLine(
  prompter: WizardPrompter,
  token: string,
  project: PhotonProjectSummary,
): Promise<string | undefined> {
  const mode = await getPhotonImessageMode(token, project.projectId).catch(() => ({ mode: "unknown" as const }));
  const entered = (
    await prompter.text({
      message: t("wizard.photon.handlePrompt"),
      placeholder: "+15551234567",
      validate: (value) =>
        !value?.trim() || isValidPhotonHandle(value.trim()) ? undefined : t("wizard.photon.handleInvalid"),
    })
  ).trim();
  const handle = entered ? normalizePhotonHandle(entered) : undefined;
  const lines: string[] = [t("wizard.photon.provisionedProject", { name: project.name })];

  if (mode.mode === "dedicated") {
    const dedicated = await listPhotonDedicatedLines(token, project.projectId).catch(() => []);
    lines.push(
      dedicated.length > 0
        ? t("wizard.photon.dedicatedLine", { line: dedicated.join(", ") })
        : t("wizard.photon.dedicatedLineMissing", { url: PHOTON_DASHBOARD_URL }),
    );
  } else if (mode.mode === "unknown") {
    // Without the line settings this could be a dedicated-line project, so
    // don't spend a shared seat on a guess.
    lines.push(t("wizard.photon.lineModeUnknown", { url: PHOTON_DASHBOARD_URL }));
  } else if (!handle) {
    lines.push(t("wizard.photon.noHandleAdded", { url: PHOTON_DASHBOARD_URL }));
  } else {
    try {
      const shared = await withProgress(prompter, t("wizard.photon.assigningLine"), () =>
        ensurePhotonSharedLine(token, project.projectId, handle),
      );
      lines.push(t("wizard.photon.sharedLine", { line: shared.line, handle }));
    } catch (err) {
      lines.push(t("wizard.photon.assignFailed", { error: describeProvisionError(err), url: PHOTON_DASHBOARD_URL }));
    }
  }
  await prompter.note(lines.join("\n"), t("wizard.photon.provisionedTitle"));
  return handle;
}

/**
 * One-pass setup: sign in to Photon with a device code, pick or create the
 * project, give the person a line, and create the gateway's API key.
 */
async function runPhotonDeviceSetup(prompter: WizardPrompter): Promise<PhotonDeviceSetupResult> {
  const code = await requestPhotonDeviceCode();
  await prompter.note(
    [
      t("wizard.photon.deviceApproveLine", {
        url: code.verificationUriComplete ?? code.verificationUri,
      }),
      t("wizard.photon.deviceCodeLine", { code: code.userCode }),
    ].join("\n"),
    t("wizard.photon.deviceLoginTitle"),
  );
  const signIn = await withProgress(prompter, t("wizard.photon.deviceWaiting"), () =>
    pollPhotonDeviceToken(code),
  );
  const project = await choosePhotonProject(prompter, signIn.token);
  // The line first: a setup cancelled at that prompt leaves no unused key.
  const handle = await preparePhotonLine(prompter, signIn.token, project);
  const key = await withProgress(prompter, t("wizard.photon.creatingKey"), () =>
    createPhotonGatewayKey(signIn.token, project.projectId),
  );
  return { project, apiKey: key.secret, handle };
}

export const photonSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ cfg, accountId }) => accountId?.trim() || resolveDefaultPhotonAccountId(cfg),
  applyAccountName: ({ cfg, accountId, name }) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: buildPhotonSetupPatch(accountId, name?.trim() ? { name: name.trim() } : {}),
    }),
  validateInput: ({ accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      projectId?: string;
      apiKey?: string;
    };
    if (typedInput.useEnv) {
      // Environment credentials only apply to the default account.
      if (accountId !== DEFAULT_ACCOUNT_ID) {
        return "Photon --use-env only works for the default account.";
      }
      if (!process.env.PHOTON_PROJECT_ID?.trim() || !process.env.PHOTON_API_KEY?.trim()) {
        return "Photon --use-env needs PHOTON_PROJECT_ID and PHOTON_API_KEY in the environment.";
      }
      return null;
    }
    if (!typedInput.projectId?.trim()) {
      return "Photon requires --project-id or --use-env.";
    }
    if (!typedInput.apiKey?.trim()) {
      return "Photon requires --api-key or --use-env.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      projectId?: string;
      apiKey?: string;
    };
    return patchTopLevelChannelConfigSection({
      cfg,
      channel,
      enabled: true,
      clearFields: typedInput.useEnv ? ["projectId", "apiKey", "projectSecret"] : ["projectSecret"],
      patch: buildPhotonSetupPatch(
        accountId,
        typedInput.useEnv
          ? {}
          : {
              projectId: typedInput.projectId?.trim(),
              apiKey: typedInput.apiKey?.trim(),
            },
      ),
    });
  },
};

export const photonSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: ({ accountOverride, defaultAccountId }) =>
    accountOverride?.trim() || defaultAccountId,
  resolveShouldPromptAccountIds: () => false,
  status: createStandardChannelSetupStatus({
    channelLabel: "Photon",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.photon.statusNeedsProject"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.photon.statusNeedsProject"),
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg }) => resolvePhotonAccount({ cfg }).configured,
  }),
  introNote: {
    title: t("wizard.photon.setupTitle"),
    lines: PHOTON_SETUP_HELP_LINES,
  },
  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    const account = resolvePhotonAccount({ cfg, accountId });
    if (account.configured) {
      return { cfg, credentialValues };
    }
    const useDeviceLogin = await prompter.confirm({
      message: t("wizard.photon.deviceLoginPrompt"),
      initialValue: true,
    });
    if (!useDeviceLogin) {
      return { cfg, credentialValues };
    }
    const result = await runPhotonDeviceSetup(prompter);
    const existingAllowFrom = (cfg as CoreConfig).channels?.photon?.allowFrom ?? [];
    const next = patchTopLevelChannelConfigSection({
      cfg,
      channel,
      enabled: true,
      // A v0.1 (Stable) secret has no use any more.
      clearFields: ["projectSecret"],
      patch: buildPhotonSetupPatch(accountId, {
        projectId: result.project.projectId,
        apiKey: result.apiKey,
        ...(result.handle
          ? {
              allowFrom: mergeAllowFromEntries(existingAllowFrom, [result.handle]),
              defaultTo: result.handle,
            }
          : {}),
      }),
    });
    return {
      cfg: next,
      credentialValues: {
        ...credentialValues,
        [DEVICE_SETUP_DONE_FLAG]: "1",
      },
    };
  },
  envShortcut: {
    prompt: t("wizard.photon.credentialsEnvPrompt"),
    preferredEnvVar: "PHOTON_API_KEY",
    isAvailable: ({ cfg, accountId }) =>
      accountId === DEFAULT_ACCOUNT_ID &&
      Boolean(process.env.PHOTON_PROJECT_ID?.trim()) &&
      Boolean(process.env.PHOTON_API_KEY?.trim()) &&
      !hasConfiguredSecretInput(resolvePhotonAccount({ cfg, accountId }).config.apiKey),
    apply: async ({ cfg, accountId }) =>
      patchTopLevelChannelConfigSection({
        cfg,
        channel,
        enabled: true,
        clearFields: ["projectId", "apiKey", "projectSecret"],
        patch: buildPhotonSetupPatch(accountId, {}),
      }),
  },
  credentials: [
    {
      inputKey: "apiKey",
      providerHint: channel,
      credentialLabel: "API key",
      preferredEnvVar: "PHOTON_API_KEY",
      helpTitle: t("wizard.photon.apiKeyTitle"),
      helpLines: PHOTON_SETUP_HELP_LINES,
      envPrompt: t("wizard.photon.credentialsEnvPrompt"),
      keepPrompt: t("wizard.photon.apiKeyKeep"),
      inputPrompt: t("wizard.photon.apiKeyInput"),
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      shouldPrompt: ({ credentialValues }) => credentialValues[DEVICE_SETUP_DONE_FLAG] !== "1",
      inspect: ({ cfg, accountId }) => {
        const account = resolvePhotonAccount({ cfg, accountId });
        return {
          accountConfigured: account.configured,
          hasConfiguredValue: hasConfiguredSecretInput(account.config.apiKey),
          resolvedValue: normalizeSecretInputString(account.config.apiKey),
          envValue: process.env.PHOTON_API_KEY?.trim(),
        };
      },
      applyUseEnv: async ({ cfg, accountId }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          clearFields: ["projectId", "apiKey", "projectSecret"],
          patch: buildPhotonSetupPatch(accountId, {}),
        }),
      applySet: async ({ cfg, accountId, resolvedValue }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          clearFields: ["projectSecret"],
          patch: buildPhotonSetupPatch(accountId, { apiKey: resolvedValue }),
        }),
    },
  ],
  textInputs: [
    {
      inputKey: "projectId",
      message: t("wizard.photon.projectIdInput"),
      placeholder: "pho_prj_...",
      helpTitle: t("wizard.photon.projectIdTitle"),
      helpLines: PHOTON_SETUP_HELP_LINES,
      shouldPrompt: ({ credentialValues }) => credentialValues[DEVICE_SETUP_DONE_FLAG] !== "1",
      currentValue: ({ cfg }) =>
        (cfg as CoreConfig).channels?.photon?.projectId?.trim() || undefined,
      keepPrompt: (value) => t("wizard.photon.projectIdKeep", { value }),
      validate: ({ value }) => (value.trim() ? undefined : "Required"),
      applySet: async ({ cfg, accountId, value }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          patch: buildPhotonSetupPatch(accountId, { projectId: value.trim() }),
        }),
    },
  ],
  dmPolicy: photonDmPolicy,
  disable: (cfg) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: { enabled: false },
    }),
};

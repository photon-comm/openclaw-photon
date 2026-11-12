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
import { isPhonePhotonTarget, normalizePhotonAllowEntry } from "./normalize.js";
import {
  getPhotonImessageLine,
  isValidPhotonPhone,
  pollPhotonDeviceToken,
  provisionPhotonProject,
  registerPhotonUser,
  requestPhotonDeviceCode,
  type PhotonProvisionedProject,
} from "./provision.js";
import { t } from "./setup-strings.js";
import { resolveDefaultPhotonAccountId, resolvePhotonAccount, type CoreConfig } from "./types.js";

const DOCS_URL = "https://github.com/photon-hq/openclaw-photon#readme";

const channel = "photon" as const;
// Set after a successful device-login provisioning run so the manual
// project-id/secret prompts are skipped for this wizard pass.
const DEVICE_SETUP_DONE_FLAG = "__photonDeviceSetupDone";

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
    if (normalized === "*" || isPhonePhotonTarget(normalized)) {
      return { value: normalized };
    }
    return { error: `Invalid Photon sender (expected E.164 phone): ${entry}` };
  });
}

const promptPhotonAllowFrom = createTopLevelChannelParsedAllowFromPrompt({
  channel,
  defaultAccountId: resolveDefaultPhotonAccountId,
  noteTitle: t("wizard.photon.allowlistTitle"),
  noteLines: PHOTON_ALLOW_FROM_HELP_LINES,
  message: t("wizard.photon.allowFromPrompt"),
  placeholder: "+15551234567, +447700900123",
  parseEntries: parsePhotonAllowFrom,
  mergeEntries: ({ existing, parsed }) => mergeAllowFromEntries(existing, parsed),
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
  project: PhotonProvisionedProject;
  phoneNumber?: string;
  assignedLine?: string;
};

/**
 * One-pass setup: device login (RFC 8628) on app.photon.codes, find or create
 * the OpenClaw project, read its Spectrum credentials, and register the
 * operator's phone as a Spectrum user so Photon assigns them a line.
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

  const waiting = prompter.progress(t("wizard.photon.deviceWaiting"));
  let token: string;
  try {
    token = await pollPhotonDeviceToken(code);
  } finally {
    waiting.stop();
  }

  const provisioning = prompter.progress(t("wizard.photon.provisioning"));
  let project: PhotonProvisionedProject;
  try {
    project = await provisionPhotonProject({ token });
  } finally {
    provisioning.stop();
  }

  const phoneNumber = (
    await prompter.text({
      message: t("wizard.photon.phonePrompt"),
      placeholder: "+15551234567",
      validate: (value) =>
        !value?.trim() || isValidPhotonPhone(value.trim())
          ? undefined
          : "Use an E.164 phone number, e.g. +15551234567",
    })
  ).trim();

  let assignedLine: string | undefined;
  if (phoneNumber) {
    const registering = prompter.progress(t("wizard.photon.registeringUser"));
    try {
      const user = await registerPhotonUser({
        spectrumProjectId: project.spectrumProjectId,
        projectSecret: project.projectSecret,
        phoneNumber,
      });
      assignedLine = user.assignedPhoneNumber;
    } finally {
      registering.stop();
    }
    // Freshly created users may not have a line assigned yet; the project
    // line inventory is the fallback source for the number to text.
    if (!assignedLine) {
      try {
        assignedLine = await getPhotonImessageLine(token, project.dashboardProjectId);
      } catch {
        assignedLine = undefined;
      }
    }
  }

  await prompter.note(
    [
      t("wizard.photon.provisionedProject", { name: project.projectName }),
      ...(project.secretRotated ? [t("wizard.photon.secretRotated")] : []),
      assignedLine
        ? t("wizard.photon.assignedLine", { line: assignedLine })
        : t("wizard.photon.assignedLinePending"),
    ].join("\n"),
    t("wizard.photon.provisionedTitle"),
  );

  return { project, phoneNumber: phoneNumber || undefined, assignedLine };
}

export const photonSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ cfg, accountId }) => accountId?.trim() || resolveDefaultPhotonAccountId(cfg),
  applyAccountName: ({ cfg, accountId, name }) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: buildPhotonSetupPatch(accountId, name?.trim() ? { name: name.trim() } : {}),
    }),
  validateInput: ({ input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      projectId?: string;
      projectSecret?: string;
    };
    if (typedInput.useEnv) {
      return null;
    }
    if (!typedInput.projectId?.trim()) {
      return "Photon requires --project-id or --use-env.";
    }
    if (!typedInput.projectSecret?.trim()) {
      return "Photon requires --project-secret or --use-env.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      projectId?: string;
      projectSecret?: string;
    };
    return patchTopLevelChannelConfigSection({
      cfg,
      channel,
      enabled: true,
      clearFields: typedInput.useEnv ? ["projectId", "projectSecret"] : undefined,
      patch: buildPhotonSetupPatch(
        accountId,
        typedInput.useEnv
          ? {}
          : {
              projectId: typedInput.projectId?.trim(),
              projectSecret: typedInput.projectSecret?.trim(),
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
      patch: buildPhotonSetupPatch(accountId, {
        projectId: result.project.spectrumProjectId,
        projectSecret: result.project.projectSecret,
        ...(result.phoneNumber
          ? {
              allowFrom: mergeAllowFromEntries(existingAllowFrom, [result.phoneNumber]),
              defaultTo: result.phoneNumber,
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
    preferredEnvVar: "PHOTON_PROJECT_SECRET",
    isAvailable: ({ cfg, accountId }) =>
      accountId === DEFAULT_ACCOUNT_ID &&
      Boolean(process.env.PHOTON_PROJECT_ID?.trim()) &&
      Boolean(process.env.PHOTON_PROJECT_SECRET?.trim()) &&
      !hasConfiguredSecretInput(resolvePhotonAccount({ cfg, accountId }).config.projectSecret),
    apply: async ({ cfg, accountId }) =>
      patchTopLevelChannelConfigSection({
        cfg,
        channel,
        enabled: true,
        clearFields: ["projectId", "projectSecret"],
        patch: buildPhotonSetupPatch(accountId, {}),
      }),
  },
  credentials: [
    {
      inputKey: "projectSecret",
      providerHint: channel,
      credentialLabel: "project secret",
      preferredEnvVar: "PHOTON_PROJECT_SECRET",
      helpTitle: t("wizard.photon.projectSecretTitle"),
      helpLines: PHOTON_SETUP_HELP_LINES,
      envPrompt: t("wizard.photon.credentialsEnvPrompt"),
      keepPrompt: t("wizard.photon.projectSecretKeep"),
      inputPrompt: t("wizard.photon.projectSecretInput"),
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      shouldPrompt: ({ credentialValues }) => credentialValues[DEVICE_SETUP_DONE_FLAG] !== "1",
      inspect: ({ cfg, accountId }) => {
        const account = resolvePhotonAccount({ cfg, accountId });
        return {
          accountConfigured: account.configured,
          hasConfiguredValue: hasConfiguredSecretInput(account.config.projectSecret),
          resolvedValue: normalizeSecretInputString(account.config.projectSecret),
          envValue: process.env.PHOTON_PROJECT_SECRET?.trim(),
        };
      },
      applyUseEnv: async ({ cfg, accountId }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          clearFields: ["projectId", "projectSecret"],
          patch: buildPhotonSetupPatch(accountId, {}),
        }),
      applySet: async ({ cfg, accountId, resolvedValue }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel,
          enabled: true,
          patch: buildPhotonSetupPatch(accountId, { projectSecret: resolvedValue }),
        }),
    },
  ],
  textInputs: [
    {
      inputKey: "projectId",
      message: t("wizard.photon.projectIdInput"),
      placeholder: "spectrum project id",
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

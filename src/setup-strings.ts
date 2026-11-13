// English copy for the Photon setup wizard. OpenClaw's own setup translator
// only knows core keys, so an external plugin carries its strings itself.
const STRINGS = {
  "wizard.channels.statusConfigured": "configured",
  "wizard.photon.setupTitle": "Photon iMessage",
  "wizard.photon.statusNeedsProject": "needs a Photon project",
  "wizard.photon.helpDeviceLogin":
    "Sign in with Photon and setup picks or creates a project, creates an API key for the gateway and gives you an iMessage number to text.",
  "wizard.photon.helpProjectCredentials":
    "Already have a key? Use the project ID from Settings and an API key with project:read, project:write and platforms:read from API keys, at https://app.beta.photon.codes.",
  "wizard.photon.helpEnvVars":
    "Or set PHOTON_PROJECT_ID and PHOTON_API_KEY in the gateway's environment.",
  "wizard.photon.deviceLoginPrompt": "Sign in with Photon now? (recommended)",
  "wizard.photon.deviceLoginTitle": "Sign in with Photon",
  "wizard.photon.deviceApproveLine": "Open {url} and approve the sign-in.",
  "wizard.photon.deviceCodeLine": "Confirmation code: {code}",
  "wizard.photon.deviceWaiting": "Waiting for you to approve the sign-in",
  "wizard.photon.loadingProjects": "Reading your Photon projects",
  "wizard.photon.noOrganization":
    "Your Photon account has no organization yet. Finish signing up at {url}, then run setup again.",
  "wizard.photon.organizationPrompt": "Photon organization",
  "wizard.photon.projectPrompt": "Photon project for this gateway",
  "wizard.photon.createProjectOption": "Create a new project named {name}",
  "wizard.photon.creatingProject": "Creating the project",
  "wizard.photon.preparingProject": "Waiting for Photon to finish setting up the project",
  "wizard.photon.creatingKey": "Creating an API key for the gateway",
  "wizard.photon.handlePrompt":
    "The phone number (like +15551234567) or iMessage email you will text the agent from. Leave empty to skip.",
  "wizard.photon.handleInvalid": "Use a phone number with its country code, like +15551234567, or an email",
  "wizard.photon.assigningLine": "Assigning you an iMessage line",
  "wizard.photon.provisionedTitle": "Photon is ready",
  "wizard.photon.provisionedProject": "Project: {name}",
  "wizard.photon.sharedLine":
    "Text {line} from {handle} to reach your agent. It's a shared line, so it answers only after you text it first.",
  "wizard.photon.dedicatedLine": "Text {line} to reach your agent.",
  "wizard.photon.dedicatedLineMissing":
    "This project uses dedicated lines but has none yet. Add one under iMessage at {url}, then text it.",
  "wizard.photon.noHandleAdded":
    "No number added. Add the number or email you'll text from under iMessage in your project at {url}, or run setup again.",
  "wizard.photon.lineModeUnknown":
    "Couldn't read this project's iMessage line settings, so no line was assigned. The project and key are saved; check iMessage at {url}, or run setup again.",
  "wizard.photon.assignFailed":
    "Couldn't assign you a line ({error}). The project and key are saved; assign one under iMessage at {url}, or run setup again.",
  "wizard.photon.allowlistTitle": "Who can message the agent",
  "wizard.photon.allowlistIntro": "Only these phone numbers and iMessage emails can talk to the agent.",
  "wizard.photon.examples": "Examples:",
  "wizard.photon.multipleEntries": "Separate several entries with commas.",
  "wizard.photon.allowFromPrompt": "Phone numbers or emails allowed to message the agent",
  "wizard.photon.credentialsEnvPrompt": "PHOTON_PROJECT_ID and PHOTON_API_KEY are set. Use them?",
  "wizard.photon.apiKeyTitle": "Photon API key",
  "wizard.photon.apiKeyKeep": "An API key is already set. Keep it?",
  "wizard.photon.apiKeyInput": "Photon API key (pho_sk_...)",
  "wizard.photon.projectIdTitle": "Photon project ID",
  "wizard.photon.projectIdInput": "Photon project ID (pho_prj_...)",
  "wizard.photon.projectIdKeep": "Project ID {value} is set. Keep it?",
} as const;

export type PhotonSetupStringKey = keyof typeof STRINGS;

/** Look up a wizard string and fill `{name}` placeholders. */
export function t(key: PhotonSetupStringKey, vars?: Record<string, string>): string {
  const template: string = STRINGS[key];
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}

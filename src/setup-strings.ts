// English copy for the Photon setup wizard. OpenClaw's own setup translator
// only knows core keys, so an external plugin carries its strings itself.
const STRINGS = {
  "wizard.channels.statusConfigured": "configured",
  "wizard.photon.setupTitle": "Photon iMessage",
  "wizard.photon.statusNeedsProject": "needs a Photon project",
  "wizard.photon.helpDeviceLogin":
    "Sign in with Photon and setup creates an OpenClaw project, reads its credentials and gives you an iMessage number to text.",
  "wizard.photon.helpProjectCredentials":
    "Already have a project? Use its ID and secret from Settings at https://app.photon.codes.",
  "wizard.photon.helpEnvVars":
    "Or set PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET in the gateway's environment.",
  "wizard.photon.deviceLoginPrompt": "Sign in with Photon now? (recommended)",
  "wizard.photon.deviceLoginTitle": "Sign in with Photon",
  "wizard.photon.deviceApproveLine": "Open {url} and approve the sign-in.",
  "wizard.photon.deviceCodeLine": "Confirmation code: {code}",
  "wizard.photon.deviceWaiting": "Waiting for you to approve the sign-in",
  "wizard.photon.provisioning": "Setting up your Photon project",
  "wizard.photon.phonePrompt":
    "Your phone number, to text the agent from (E.164, like +15551234567). Leave empty to skip.",
  "wizard.photon.registeringUser": "Adding your number to the project",
  "wizard.photon.provisionedTitle": "Photon is ready",
  "wizard.photon.provisionedProject": "Project: {name}",
  "wizard.photon.assignedLine": "Text {line} from your phone to reach your agent.",
  "wizard.photon.assignedLinePending":
    "Your number is added. Photon is still assigning the line to text; it shows under Users in your project at https://app.photon.codes.",
  "wizard.photon.secretRotated":
    "Setup generated a new project secret. Anything else using the old one needs the new secret.",
  "wizard.photon.allowlistTitle": "Who can message the agent",
  "wizard.photon.allowlistIntro": "Only these phone numbers can talk to the agent.",
  "wizard.photon.examples": "Examples:",
  "wizard.photon.multipleEntries": "Separate several numbers with commas.",
  "wizard.photon.allowFromPrompt": "Phone numbers allowed to message the agent",
  "wizard.photon.credentialsEnvPrompt":
    "PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET are set. Use them?",
  "wizard.photon.projectSecretTitle": "Photon project secret",
  "wizard.photon.projectSecretKeep": "A project secret is already set. Keep it?",
  "wizard.photon.projectSecretInput": "Photon project secret",
  "wizard.photon.projectIdTitle": "Photon project ID",
  "wizard.photon.projectIdInput": "Photon project ID",
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

// Cheap "is Photon configured?" check OpenClaw runs before loading the plugin:
// a project ID plus an API key, from config or from the environment.
type PhotonConfiguredStateParams = {
  cfg?: { channels?: Record<string, unknown> };
  env?: NodeJS.ProcessEnv;
};

function present(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  // A SecretRef object ({ source, provider, id }) counts as configured.
  return Boolean(value && typeof value === "object");
}

export function hasPhotonConfiguredState(params: PhotonConfiguredStateParams): boolean {
  const section = params.cfg?.channels?.photon as
    | { enabled?: boolean; projectId?: unknown; apiKey?: unknown }
    | undefined;
  if (section?.enabled === false) {
    return false;
  }
  const env = params.env ?? {};
  return (
    present(section?.projectId || env.PHOTON_PROJECT_ID) &&
    present(section?.apiKey || env.PHOTON_API_KEY)
  );
}

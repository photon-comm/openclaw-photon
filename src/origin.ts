// Where Photon Beta lives. Kept apart from the API client so setup and cold
// plugin loads can read it without loading the client.
export const DEFAULT_PHOTON_API_ORIGIN = "https://api.photon.codes";
export const PHOTON_DASHBOARD_URL = "https://app.beta.photon.codes";

/** API origin; `PHOTON_API_ORIGIN` points the plugin at another Photon environment. */
export function photonApiOrigin(): string {
  return (process.env.PHOTON_API_ORIGIN?.trim() || DEFAULT_PHOTON_API_ORIGIN).replace(/\/+$/, "");
}

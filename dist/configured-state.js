function present(value) {
    if (typeof value === "string") {
        return value.trim().length > 0;
    }
    // A SecretRef object ({ source, provider, id }) counts as configured.
    return Boolean(value && typeof value === "object");
}
export function hasPhotonConfiguredState(params) {
    const section = params.cfg?.channels?.photon;
    if (section?.enabled === false) {
        return false;
    }
    const env = params.env ?? {};
    return (present(section?.projectId || env.PHOTON_PROJECT_ID) &&
        present(section?.apiKey || env.PHOTON_API_KEY));
}

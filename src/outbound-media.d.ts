// OpenClaw exports `openclaw/plugin-sdk/outbound-media` without type
// declarations (2026.11.3). This covers the one loader the plugin uses: it
// reads a remote URL or a host-approved local path under the shared media
// policy (size cap, SSRF guard, local roots).
declare module "openclaw/plugin-sdk/outbound-media" {
  export type OutboundMediaLoadParams = {
    maxBytes?: number;
    mediaAccess?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
      workspaceDir?: string;
    };
    mediaLocalRoots?: readonly string[] | "any";
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    optimizeImages?: boolean;
    workspaceDir?: string;
  };
  export function loadOutboundMediaFromUrl(
    mediaUrl: string,
    options?: OutboundMediaLoadParams,
  ): Promise<{ buffer: Buffer; contentType?: string; kind?: string; fileName?: string }>;
}

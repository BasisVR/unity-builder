/**
 * BasisVR's Unity Editor Docker-tag fallback, adapted for GameCI v6.
 *
 * The v6 action invokes game-ci/cli rather than constructing the Docker
 * command itself. When an official unityci/editor tag doesn't exist, resolve
 * the nearest earlier compatible tag and supply both --customImage and
 * --engineVersion to the CLI. Never replace a caller's custom image.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface UnityImageFallbackOptions {
  projectPath: string;
  targetPlatform: string;
  unityVersion?: string;
  customImage?: string;
  containerRegistryRepository?: string;
  containerRegistryImageVersion?: string;
  providerStrategy?: string;
  hostPlatform?: NodeJS.Platform;
  fetcher?: typeof fetch;
  log?: (message: string) => void;
}

export interface UnityImageFallbackResult {
  customImage?: string;
  unityVersion?: string;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
  stream: number;
  streamNumber: number;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)([abcfp])(\d+)$/i;
const TAG = /^(ubuntu|windows)-(\d+\.\d+\.\d+[abcfp]\d+)(?:-(.+))?-(\d+)$/i;
const STREAM_ORDER: Record<string, number> = { a: 0, b: 1, c: 2, f: 3, p: 4 };
const MAX_PAGES = 40;

function parseVersion(value: string): Version | undefined {
  const m = VERSION.exec(value);
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    stream: STREAM_ORDER[m[4].toLowerCase()],
    streamNumber: Number(m[5]),
  };
}

function compareVersions(a: Version, b: Version): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    a.stream - b.stream ||
    a.streamNumber - b.streamNumber
  );
}

function projectVersion(projectPath: string): string | undefined {
  const file = path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt');
  const content = fs.readFileSync(file, 'utf8');
  return (
    /^m_EditorVersion:\s*(\S+)/m.exec(content)?.[1] ??
    /^m_EditorVersionWithRevision:\s*(\S+)/m.exec(content)?.[1]
  );
}

function targetModule(
  targetPlatform: string,
  version: Version,
  host: NodeJS.Platform,
): string | undefined {
  const il2cpp = version.major >= 2020 || (version.major === 2019 && version.minor >= 3);
  switch (targetPlatform) {
    case 'StandaloneLinux64':
      return il2cpp ? 'linux-il2cpp' : 'base';
    case 'StandaloneWindows':
    case 'StandaloneWindows64':
      return host === 'win32' && il2cpp ? 'windows-il2cpp' : 'windows-mono';
    case 'Android':
      return 'android';
    case 'WebGL':
      return 'webgl';
    case 'StandaloneOSX':
      return 'mac-mono';
    case 'iOS':
      return 'ios';
    case 'tvOS':
      return 'appletv';
    case 'VisionOS':
      return 'visionos';
    case 'WSAPlayer':
      return 'universal-windows-platform';
    case 'PS4':
    case 'XboxOne':
    case 'Switch':
      return 'windows-mono';
    default:
      return undefined;
  }
}

async function getResponse(fetcher: typeof fetch, url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    return await fetcher(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'BasisVR-unity-builder' },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function candidateFromTag(
  name: string,
  prefix: string,
  module: string,
  rolling: string,
  requested: Version,
): { name: string; version: Version } | undefined {
  const m = TAG.exec(name);
  if (!m || m[1] !== prefix || (m[3] ?? '') !== module || m[4] !== rolling) return undefined;
  const version = parseVersion(m[2]);
  if (!version || compareVersions(version, requested) >= 0 || version.major !== requested.major) {
    return undefined;
  }
  return { name, version };
}

async function closestMatchingTag(
  fetcher: typeof fetch,
  repository: string,
  prefix: string,
  module: string,
  rolling: string,
  requested: Version,
): Promise<{ name: string; version: Version } | undefined> {
  const root = `https://hub.docker.com/v2/repositories/${repository}/tags`;
  // Prefer the closest earlier editor in the same minor stream, then in the
  // same major stream. Preserve the platform module and rolling image revision.
  for (const filter of [
    `${prefix}-${requested.major}.${requested.minor}.`,
    `${prefix}-${requested.major}.`,
  ]) {
    let next: string | null = `${root}?page_size=100&name=${encodeURIComponent(filter)}`;
    let best: { name: string; version: Version } | undefined;
    const seen = new Set<string>();

    for (let page = 0; next && page < MAX_PAGES; page += 1) {
      const uri = new URL(next);
      if (uri.origin !== 'https://hub.docker.com' || uri.pathname !== new URL(root).pathname) {
        throw new Error('Unexpected Docker Hub pagination URL');
      }
      if (seen.has(next)) throw new Error('Repeated Docker Hub pagination URL');
      seen.add(next);

      const response = await getResponse(fetcher, next);
      if (!response.ok)
        throw new Error(`Docker Hub returned HTTP ${response.status} for tag listing`);
      const data = (await response.json()) as {
        results?: Array<{ name?: string }>;
        next?: string | null;
      };
      if (!Array.isArray(data.results)) throw new Error('Invalid Docker Hub tag list');
      for (const entry of data.results) {
        if (typeof entry.name !== 'string') continue;
        const candidate = candidateFromTag(entry.name, prefix, module, rolling, requested);
        if (!candidate) continue;
        // A same-major query must not outrank the same-minor search.
        if (!best || compareVersions(candidate.version, best.version) > 0) best = candidate;
      }
      next = data.next ? new URL(data.next, root).toString() : null;
      if (page === MAX_PAGES - 1 && next) {
        // Do not select from an incomplete listing: the actual closest match
        // may be on the remaining pages.
        throw new Error('Docker Hub tag listing exceeded pagination budget');
      }
    }
    if (best) return best;
  }
  return undefined;
}

/**
 * Resolve an older official Docker image only when the requested tag is
 * confirmed missing (HTTP 404). Network errors and non-404 responses leave
 * the original choice unchanged rather than silently switching versions.
 */
export async function resolveUnityImageFallback(
  options: UnityImageFallbackOptions,
): Promise<UnityImageFallbackResult> {
  const log = options.log ?? (() => {});
  const unchanged: UnityImageFallbackResult = {};
  const provider = options.providerStrategy || 'local';
  const host = options.hostPlatform ?? process.platform;
  const repository = options.containerRegistryRepository || 'unityci/editor';
  const rolling = options.containerRegistryImageVersion || '3';

  if (options.customImage || provider !== 'local' || (host !== 'linux' && host !== 'win32'))
    return unchanged;
  // Preserve the original fork's policy: only resolve official UnityCI images.
  if (!/^unityci\/[a-z0-9._/-]+$/.test(repository) || !/^\d+$/.test(rolling)) return unchanged;

  try {
    const requestedName =
      options.unityVersion && options.unityVersion !== 'auto'
        ? options.unityVersion
        : projectVersion(options.projectPath);
    const requested = requestedName ? parseVersion(requestedName) : undefined;
    if (!requestedName || !requested) return unchanged;

    const module = targetModule(options.targetPlatform, requested, host);
    if (!module) return unchanged;

    const prefix = host === 'win32' ? 'windows' : 'ubuntu';
    const tag = `${prefix}-${requestedName}-${module}-${rolling}`;
    const fetcher = options.fetcher ?? fetch;
    const url = `https://hub.docker.com/v2/repositories/${repository}/tags/${encodeURIComponent(tag)}`;
    const exactResponse = await getResponse(fetcher, url);

    if (exactResponse.ok) return unchanged;
    if (exactResponse.status !== 404) {
      log(`Unity image lookup received HTTP ${exactResponse.status}; keeping ${repository}:${tag}`);
      return unchanged;
    }

    const fallback = await closestMatchingTag(
      fetcher,
      repository,
      prefix,
      module,
      rolling,
      requested,
    );
    if (!fallback) {
      log(`No compatible older Unity image available for ${repository}:${tag}`);
      return unchanged;
    }

    const fallbackImage = `${repository}:${fallback.name}`;
    const fallbackVersion = /^\w+-(\d+\.\d+\.\d+[abcfp]\d+)/i.exec(fallback.name)?.[1];
    if (!fallbackVersion) return unchanged;

    log(
      `Unity image ${repository}:${tag} not found; using ${fallbackImage} and editor ${fallbackVersion}`,
    );
    return { customImage: fallbackImage, unityVersion: fallbackVersion };
  } catch (error) {
    log(
      `Unity image fallback lookup failed (${error instanceof Error ? error.message : String(error)}); keeping original image`,
    );
    return unchanged;
  }
}

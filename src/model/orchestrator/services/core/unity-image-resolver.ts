import BuildParameters from '../../../build-parameters';
import OrchestratorLogger from './orchestrator-logger';
import https from 'node:https';
import { IncomingHttpHeaders } from 'node:http';

type DockerHubTagListResponse = {
  count: number;
  next: string | null;
  results: Array<{ name: string }>;
};

type UnityVersionParts = {
  major: number;
  minor: number;
  patch: number;
  stream: string;
  streamNumber: number;
};

type ParsedUnityImageTag = {
  platformPrefix: string;
  editorVersion: string;
  builderPlatform: string;
  rollingVersion: number;
};

type ParsedImageReference = {
  repository: string;
  tag: string;
  parsedTag: ParsedUnityImageTag;
};

type LookupScope = 'sameMinor' | 'sameMajor' | 'anyLower';
type LookupSelectionMode = 'best' | 'first';

class UnityImageResolver {
  private static readonly dockerHubPageSize = 100;
  private static readonly requestTimeoutMs = 4_000;
  private static readonly rateLimitPauseMs = 60_000;
  private static readonly streamOrder: Record<string, number> = {
    a: 0,
    b: 1,
    c: 2,
    f: 3,
    p: 4,
  };
  private static readonly tagExistsCache = new Map<string, boolean>();
  private static readonly versionCache = new Map<string, string[]>();

  static async resolveImage(
    buildParameters: BuildParameters,
    baseImage: string,
  ): Promise<{ image: string; editorVersion: string }> {
    try {
      if (buildParameters.customImage) {
        return { image: baseImage, editorVersion: buildParameters.editorVersion };
      }

      const parsedImage = this.parseImageReference(baseImage);
      if (!parsedImage) {
        return { image: baseImage, editorVersion: buildParameters.editorVersion };
      }

      if (!parsedImage.repository.startsWith('unityci/')) {
        return { image: baseImage, editorVersion: buildParameters.editorVersion };
      }

      const exactTagExists = await this.doesDockerHubTagExist(parsedImage.repository, parsedImage.tag);
      if (exactTagExists) {
        return { image: baseImage, editorVersion: buildParameters.editorVersion };
      }

      const { platformPrefix, builderPlatform, rollingVersion, editorVersion } = parsedImage.parsedTag;
      const availableVersions = await this.listMatchingUnityVersions(
        parsedImage.repository,
        platformPrefix,
        builderPlatform,
        rollingVersion,
        editorVersion,
      );

      const fallbackVersion = this.selectClosestDowngradeVersion(editorVersion, availableVersions);
      if (!fallbackVersion) {
        OrchestratorLogger.log(
          `Unity image ${baseImage} was not found in Docker Hub and no lower compatible Unity version was available`,
        );
        return { image: baseImage, editorVersion: buildParameters.editorVersion };
      }

      const fallbackTag = this.composeTag(platformPrefix, fallbackVersion, builderPlatform, rollingVersion);
      const fallbackImage = `${parsedImage.repository}:${fallbackTag}`;
      OrchestratorLogger.log(`Unity image ${baseImage} not found. Falling back to ${fallbackImage}`);

      return { image: fallbackImage, editorVersion: fallbackVersion };
    } catch (error: any) {
      OrchestratorLogger.log(`Unity image resolver failed: ${error?.message || error}. Continuing with ${baseImage}`);
      return { image: baseImage, editorVersion: buildParameters.editorVersion };
    }
  }

  static selectClosestDowngradeVersion(requestedVersion: string, availableVersions: string[]): string | undefined {
    const requested = this.parseUnityVersion(requestedVersion);
    if (!requested) {
      return undefined;
    }

    const uniqueCandidates = [...new Set(availableVersions)]
      .filter((version) => {
        const candidate = this.parseUnityVersion(version);
        if (!candidate) {
          return false;
        }
        return this.compareUnityVersionParts(candidate, requested) < 0;
      })
      .sort((a, b) => this.compareUnityVersions(b, a));

    return uniqueCandidates[0];
  }

  static async doesDockerHubTagExist(repository: string, tag: string): Promise<boolean> {
    const cacheKey = `${repository}:${tag}`;
    const cached = this.tagExistsCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    let response: { statusCode: number; body: any | null };
    try {
      const url = `https://hub.docker.com/v2/repositories/${repository}/tags/${encodeURIComponent(tag)}`;
      response = await this.getJson(url);
    } catch (error: any) {
      if (this.isRateLimitError(error)) {
        OrchestratorLogger.log(
          `Rate limited while checking ${repository}:${tag}. Waiting ${
            this.rateLimitPauseMs / 1000
          }s before continuing`,
        );
        await this.sleep(this.rateLimitPauseMs);
        this.tagExistsCache.set(cacheKey, false);
        return false;
      }
      if (this.isTimeoutError(error)) {
        OrchestratorLogger.log(
          `Timed out while checking ${repository}:${tag}; treating as missing and continuing with fallback lookup`,
        );
        this.tagExistsCache.set(cacheKey, false);
        return false;
      }
      throw error;
    }

    if (response.statusCode === 404) {
      this.tagExistsCache.set(cacheKey, false);
      return false;
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      this.tagExistsCache.set(cacheKey, true);
      return true;
    }

    throw new Error(`Failed to check image tag ${repository}:${tag} (HTTP ${response.statusCode})`);
  }

  static async listMatchingUnityVersions(
    repository: string,
    platformPrefix: string,
    builderPlatform: string,
    rollingVersion: number,
    requestedVersion: string,
  ): Promise<string[]> {
    const cacheKey = `${repository}|${platformPrefix}|${builderPlatform}|${rollingVersion}|${requestedVersion}`;
    const cached = this.versionCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const requested = this.parseUnityVersion(requestedVersion);
    if (!requested) {
      return [];
    }

    const contexts = [
      { filter: requestedVersion, scope: 'sameMinor' as LookupScope, mode: 'best' as LookupSelectionMode },
      {
        filter: `${requested.major}.${requested.minor}`,
        scope: 'sameMinor' as LookupScope,
        mode: 'best' as LookupSelectionMode,
      },
      { filter: `${requested.major}`, scope: 'sameMajor' as LookupScope, mode: 'first' as LookupSelectionMode },
      {
        filter: `${platformPrefix}-${requestedVersion}`,
        scope: 'sameMinor' as LookupScope,
        mode: 'first' as LookupSelectionMode,
      },
      {
        filter: `${platformPrefix}-${requested.major}.${requested.minor}`,
        scope: 'sameMinor' as LookupScope,
        mode: 'first' as LookupSelectionMode,
      },
      {
        filter: `${platformPrefix}-${requested.major}`,
        scope: 'sameMajor' as LookupScope,
        mode: 'first' as LookupSelectionMode,
      },
    ];
    let hadTimeout = false;

    for (const context of contexts) {
      const contextResult = await this.listMatchingUnityVersionsForFilter(
        repository,
        platformPrefix,
        builderPlatform,
        rollingVersion,
        context.filter,
        requested,
        context.scope,
        context.mode,
      );
      if (contextResult.bestVersion) {
        const resolved = [contextResult.bestVersion];
        this.versionCache.set(cacheKey, resolved);
        return resolved;
      }
      hadTimeout = hadTimeout || contextResult.timedOut;
    }

    if (hadTimeout) {
      OrchestratorLogger.log(
        `Falling back to broad tag scan for ${repository} because filtered lookup timed out or was rate-limited`,
      );
      const broadVersion = await this.listMatchingUnityVersionsBroad(
        repository,
        platformPrefix,
        builderPlatform,
        rollingVersion,
        requested,
      );
      if (broadVersion) {
        const resolved = [broadVersion];
        this.versionCache.set(cacheKey, resolved);
        return resolved;
      }
    }

    this.versionCache.set(cacheKey, []);
    return [];
  }

  private static async listMatchingUnityVersionsForFilter(
    repository: string,
    platformPrefix: string,
    builderPlatform: string,
    rollingVersion: number,
    nameFilter: string,
    requested: UnityVersionParts,
    scope: LookupScope,
    mode: LookupSelectionMode,
  ): Promise<{ bestVersion: string | undefined; timedOut: boolean }> {
    let bestVersion: string | undefined;
    let bestParsed: UnityVersionParts | undefined;
    let url: string | null = `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=${
      this.dockerHubPageSize
    }&name=${encodeURIComponent(nameFilter)}`;
    let pagesRead = 0;
    let totalPages = Number.POSITIVE_INFINITY;
    let timedOut = false;

    while (url && pagesRead < totalPages) {
      let response: { statusCode: number; body: DockerHubTagListResponse | null };
      try {
        response = await this.getJson<DockerHubTagListResponse>(url);
      } catch (error: any) {
        if (this.isRateLimitError(error)) {
          OrchestratorLogger.log(
            `Rate limited while scanning ${repository} with filter ${nameFilter}. Waiting ${
              this.rateLimitPauseMs / 1000
            }s, then continuing with next context`,
          );
          await this.sleep(this.rateLimitPauseMs);
          timedOut = true;
          break;
        }
        if (this.isTimeoutError(error)) {
          timedOut = true;
          break;
        }
        throw error;
      }
      if (response.statusCode < 200 || response.statusCode >= 300 || !response.body) {
        throw new Error(`Failed to list Docker Hub tags for ${repository} (HTTP ${response.statusCode})`);
      }
      if (Number.isFinite(response.body.count)) {
        totalPages = Math.max(1, Math.ceil(response.body.count / this.dockerHubPageSize));
      }

      for (const result of response.body.results || []) {
        const parsed = this.parseUnityImageTag(result.name);
        if (!parsed) {
          continue;
        }

        if (
          parsed.platformPrefix === platformPrefix &&
          parsed.builderPlatform === builderPlatform &&
          parsed.rollingVersion === rollingVersion
        ) {
          const candidateParsed = this.parseUnityVersion(parsed.editorVersion);
          if (!candidateParsed) {
            continue;
          }
          if (!this.isCandidateInScope(candidateParsed, requested, scope)) {
            continue;
          }
          if (!bestParsed || this.compareUnityVersionParts(candidateParsed, bestParsed) > 0) {
            bestParsed = candidateParsed;
            bestVersion = parsed.editorVersion;
          }
        }
      }

      // In first-fit mode, stop at first page with a valid candidate.
      if (bestVersion && mode === 'first') {
        return { bestVersion, timedOut: false };
      }

      url = response.body.next;
      pagesRead += 1;
    }

    if (url && !timedOut && Number.isFinite(totalPages)) {
      OrchestratorLogger.log(
        `Unity image lookup reached count-derived page limit (${totalPages}) while scanning ${repository} with filter ${nameFilter}`,
      );
    }

    if (timedOut) {
      OrchestratorLogger.log(
        `Unity image lookup timed out or was rate-limited while scanning ${repository} with filter ${nameFilter}; treating as no result`,
      );
    }

    return { bestVersion, timedOut };
  }

  private static async listMatchingUnityVersionsBroad(
    repository: string,
    platformPrefix: string,
    builderPlatform: string,
    rollingVersion: number,
    requested: UnityVersionParts,
  ): Promise<string | undefined> {
    let bestVersion: string | undefined;
    let bestParsed: UnityVersionParts | undefined;
    let url:
      | string
      | null = `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=${this.dockerHubPageSize}`;
    let pagesRead = 0;
    let totalPages = Number.POSITIVE_INFINITY;

    while (url && pagesRead < totalPages) {
      let response: { statusCode: number; body: DockerHubTagListResponse | null };
      try {
        response = await this.getJson<DockerHubTagListResponse>(url);
      } catch (error: any) {
        if (this.isRateLimitError(error)) {
          OrchestratorLogger.log(
            `Rate limited during broad lookup for ${repository}. Waiting ${
              this.rateLimitPauseMs / 1000
            }s, then continuing with collected candidates`,
          );
          await this.sleep(this.rateLimitPauseMs);
          break;
        }
        if (this.isTimeoutError(error)) {
          OrchestratorLogger.log(
            `Unity image broad lookup timed out for ${repository}; using collected candidates so far`,
          );
          break;
        }
        throw error;
      }

      if (response.statusCode < 200 || response.statusCode >= 300 || !response.body) {
        throw new Error(`Failed to list Docker Hub tags for ${repository} (HTTP ${response.statusCode})`);
      }
      if (Number.isFinite(response.body.count)) {
        totalPages = Math.max(1, Math.ceil(response.body.count / this.dockerHubPageSize));
      }

      for (const result of response.body.results || []) {
        const parsed = this.parseUnityImageTag(result.name);
        if (!parsed) {
          continue;
        }

        if (
          parsed.platformPrefix === platformPrefix &&
          parsed.builderPlatform === builderPlatform &&
          parsed.rollingVersion === rollingVersion
        ) {
          const candidateParsed = this.parseUnityVersion(parsed.editorVersion);
          if (!candidateParsed) {
            continue;
          }
          if (!this.isCandidateInScope(candidateParsed, requested, 'anyLower')) {
            continue;
          }
          if (!bestParsed || this.compareUnityVersionParts(candidateParsed, bestParsed) > 0) {
            bestParsed = candidateParsed;
            bestVersion = parsed.editorVersion;
          }
        }
      }

      if (bestVersion) {
        return bestVersion;
      }

      url = response.body.next;
      pagesRead += 1;
    }

    if (url && Number.isFinite(totalPages)) {
      OrchestratorLogger.log(
        `Unity image broad lookup reached count-derived page limit (${totalPages}) while scanning ${repository}`,
      );
    }

    return bestVersion;
  }

  private static composeTag(
    platformPrefix: string,
    editorVersion: string,
    builderPlatform: string,
    rollingVersion: number,
  ) {
    const versionAndPlatform = `${editorVersion}-${builderPlatform}`.replace(/-+$/, '');
    return `${platformPrefix}-${versionAndPlatform}-${rollingVersion}`;
  }

  private static parseImageReference(image: string): ParsedImageReference | undefined {
    const separatorIndex = image.lastIndexOf(':');
    if (separatorIndex < 0) {
      return undefined;
    }

    const repository = image.slice(0, separatorIndex);
    const tag = image.slice(separatorIndex + 1);
    const parsedTag = this.parseUnityImageTag(tag);

    if (!repository || !tag || !parsedTag) {
      return undefined;
    }

    return { repository, tag, parsedTag };
  }

  private static parseUnityImageTag(tag: string): ParsedUnityImageTag | undefined {
    const tagPattern = /^(windows|ubuntu)-(\d+\.\d+\.\d+[a-z]\d+)(?:-(.+))?-(\d+)$/i;
    const result = tagPattern.exec(tag);

    if (!result) {
      return undefined;
    }

    return {
      platformPrefix: result[1],
      editorVersion: result[2],
      builderPlatform: result[3] || '',
      rollingVersion: Number.parseInt(result[4], 10),
    };
  }

  private static parseUnityVersion(version: string): UnityVersionParts | undefined {
    const versionPattern = /^(\d+)\.(\d+)\.(\d+)([a-z])(\d+)$/i;
    const result = versionPattern.exec(version);
    if (!result) {
      return undefined;
    }

    return {
      major: Number.parseInt(result[1], 10),
      minor: Number.parseInt(result[2], 10),
      patch: Number.parseInt(result[3], 10),
      stream: result[4].toLowerCase(),
      streamNumber: Number.parseInt(result[5], 10),
    };
  }

  private static compareUnityVersions(a: string, b: string): number {
    const parsedA = this.parseUnityVersion(a);
    const parsedB = this.parseUnityVersion(b);
    if (!parsedA || !parsedB) {
      return 0;
    }

    return this.compareUnityVersionParts(parsedA, parsedB);
  }

  private static compareUnityVersionParts(a: UnityVersionParts, b: UnityVersionParts): number {
    if (a.major !== b.major) {
      return a.major - b.major;
    }

    if (a.minor !== b.minor) {
      return a.minor - b.minor;
    }

    if (a.patch !== b.patch) {
      return a.patch - b.patch;
    }

    const streamOrderA = this.streamOrder[a.stream] ?? 99;
    const streamOrderB = this.streamOrder[b.stream] ?? 99;
    if (streamOrderA !== streamOrderB) {
      return streamOrderA - streamOrderB;
    }

    return a.streamNumber - b.streamNumber;
  }

  private static isCandidateInScope(
    candidate: UnityVersionParts,
    requested: UnityVersionParts,
    scope: LookupScope,
  ): boolean {
    if (this.compareUnityVersionParts(candidate, requested) >= 0) {
      return false;
    }

    switch (scope) {
      case 'sameMinor':
        return candidate.major === requested.major && candidate.minor === requested.minor;
      case 'sameMajor':
        return candidate.major === requested.major;
      case 'anyLower':
        return true;
      default:
        return false;
    }
  }

  private static isTimeoutError(error: any): boolean {
    const message = `${error?.message || error}`;
    return message.includes('Request timeout');
  }

  private static isRateLimitError(error: any): boolean {
    const message = `${error?.message || error}`;
    return message.includes('Rate limited') || message.includes('HTTP 429');
  }

  private static async getJson<T = any>(url: string): Promise<{ statusCode: number; body: T | null }> {
    const response = await this.get(url);
    if (!response.body) {
      return { statusCode: response.statusCode, body: null };
    }

    try {
      return {
        statusCode: response.statusCode,
        body: JSON.parse(response.body) as T,
      };
    } catch {
      throw new Error(`Failed to parse JSON response from ${url}`);
    }
  }

  private static async get(
    url: string,
    redirectCount = 0,
  ): Promise<{
    statusCode: number;
    body: string;
    headers: IncomingHttpHeaders;
  }> {
    if (redirectCount > 3) {
      throw new Error(`Too many redirects while requesting ${url}`);
    }

    return await new Promise((resolve, reject) => {
      const request = https.get(
        url,
        {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
            'User-Agent': 'unity-builder-orchestrator',
          },
        },
        async (response) => {
          const statusCode = response.statusCode ?? 0;
          const location = response.headers.location;
          if (statusCode >= 300 && statusCode < 400 && location) {
            response.resume();
            try {
              const redirectedUrl = new URL(location, url).toString();
              const redirected = await this.get(redirectedUrl, redirectCount + 1);
              resolve(redirected);
            } catch (error) {
              reject(error);
            }
            return;
          }

          if (statusCode === 429) {
            response.resume();
            reject(new Error(`Rate limited by Docker Hub for ${url} (HTTP 429)`));
            return;
          }

          let body = '';
          response.on('data', (chunk) => {
            body += chunk.toString();
          });
          response.on('end', () => {
            resolve({ statusCode, body, headers: response.headers });
          });
        },
      );

      request.setTimeout(this.requestTimeoutMs, () => {
        request.destroy(new Error(`Request timeout after ${this.requestTimeoutMs}ms for ${url}`));
      });
      request.on('error', (error) => {
        reject(error);
      });
    });
  }

  private static async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default UnityImageResolver;

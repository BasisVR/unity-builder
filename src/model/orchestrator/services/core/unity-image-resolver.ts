import BuildParameters from '../../../build-parameters';
import OrchestratorLogger from './orchestrator-logger';
import https from 'node:https';
import { IncomingHttpHeaders } from 'node:http';

type DockerHubTagListResponse = {
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

class UnityImageResolver {
  private static readonly requestTimeoutMs = 4_000;
  private static readonly maxTagPages = 50;
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
      );

      const fallbackVersion = this.selectClosestLowerMinorVersion(editorVersion, availableVersions);
      if (!fallbackVersion) {
        OrchestratorLogger.log(
          `Unity image ${baseImage} was not found in Docker Hub and no lower Unity minor version was available`,
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

  static selectClosestLowerMinorVersion(requestedVersion: string, availableVersions: string[]): string | undefined {
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

        if (candidate.major < requested.major) {
          return true;
        }

        return candidate.major === requested.major && candidate.minor < requested.minor;
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

    const url = `https://hub.docker.com/v2/repositories/${repository}/tags/${encodeURIComponent(tag)}`;
    const response = await this.getJson(url);

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
  ): Promise<string[]> {
    const cacheKey = `${repository}|${platformPrefix}|${builderPlatform}|${rollingVersion}`;
    const cached = this.versionCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let url: string | null = `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=100`;
    const versions = new Set<string>();
    let pagesRead = 0;

    while (url && pagesRead < this.maxTagPages) {
      const response: { statusCode: number; body: DockerHubTagListResponse | null } =
        await this.getJson<DockerHubTagListResponse>(url);
      if (response.statusCode < 200 || response.statusCode >= 300 || !response.body) {
        throw new Error(`Failed to list Docker Hub tags for ${repository} (HTTP ${response.statusCode})`);
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
          versions.add(parsed.editorVersion);
        }
      }

      url = response.body.next;
      pagesRead += 1;
    }

    if (url) {
      OrchestratorLogger.log(
        `Unity image lookup reached page limit (${this.maxTagPages}) while scanning ${repository}`,
      );
    }

    const collected = [...versions];
    this.versionCache.set(cacheKey, collected);
    return collected;
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

    if (parsedA.major !== parsedB.major) {
      return parsedA.major - parsedB.major;
    }

    if (parsedA.minor !== parsedB.minor) {
      return parsedA.minor - parsedB.minor;
    }

    if (parsedA.patch !== parsedB.patch) {
      return parsedA.patch - parsedB.patch;
    }

    const streamOrderA = this.streamOrder[parsedA.stream] ?? 99;
    const streamOrderB = this.streamOrder[parsedB.stream] ?? 99;
    if (streamOrderA !== streamOrderB) {
      return streamOrderA - streamOrderB;
    }

    return parsedA.streamNumber - parsedB.streamNumber;
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
}

export default UnityImageResolver;

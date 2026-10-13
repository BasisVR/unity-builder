import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCliArgs } from './build-args';
import { resolveUnityImageFallback, type UnityImageFallbackOptions } from './unity-image-fallback';

type Reply = { status?: number; body?: unknown };
function registry(routes: (url: string) => Reply | Promise<Reply>) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const { status = 200, body = {} } = await routes(url);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { fetcher, calls };
}

const root = 'https://hub.docker.com/v2/repositories/unityci/editor/tags';
const makeTag = (version: string, platform = 'windows-mono', prefix = 'ubuntu', rolling = '3') =>
  `${prefix}-${version}-${platform}-${rolling}`;

const tempDirs: string[] = [];
function project(version: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-builder-fallback-'));
  tempDirs.push(directory);
  fs.mkdirSync(path.join(directory, 'ProjectSettings'));
  fs.writeFileSync(
    path.join(directory, 'ProjectSettings', 'ProjectVersion.txt'),
    `m_EditorVersion: ${version}\n`,
  );
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function opts(
  fetcher: typeof fetch,
  overrides: Partial<UnityImageFallbackOptions> = {},
): UnityImageFallbackOptions {
  return {
    projectPath: '/unused',
    targetPlatform: 'StandaloneWindows64',
    unityVersion: '6000.7.0b4',
    hostPlatform: 'linux',
    fetcher,
    ...overrides,
  };
}

describe('Unity editor image fallback on GameCI v6', () => {
  it('does not query the registry when a custom image is supplied', async () => {
    const lookup = registry(() => {
      throw new Error('must not be called');
    });
    expect(
      await resolveUnityImageFallback(opts(lookup.fetcher, { customImage: 'basis-editor:local' })),
    ).toEqual({});
    expect(lookup.calls).toHaveLength(0);
  });

  it('skips remote/local-system providers and unsupported hosts', async () => {
    const lookup = registry(() => {
      throw new Error('must not be called');
    });
    for (const overrides of [
      { providerStrategy: 'local-system' },
      { providerStrategy: 'k8s' },
      { hostPlatform: 'darwin' as NodeJS.Platform },
      { containerRegistryRepository: 'some-other/editor' },
    ]) {
      expect(await resolveUnityImageFallback(opts(lookup.fetcher, overrides))).toEqual({});
    }
    expect(lookup.calls).toHaveLength(0);
  });

  it('leaves the Unity editor unchanged if the exact image exists', async () => {
    const lookup = registry(() => ({ status: 200 }));
    expect(await resolveUnityImageFallback(opts(lookup.fetcher))).toEqual({});
    expect(lookup.calls).toEqual([`${root}/${makeTag('6000.7.0b4')}`]);
  });

  it('resolves the closest lower patch and feeds the image/version into the CLI arguments', async () => {
    const lookup = registry((url) =>
      url.includes('page_size')
        ? {
            body: {
              results: [
                { name: makeTag('6000.7.0b1') },
                { name: makeTag('6000.7.0b9') }, // newer must not be selected
                { name: makeTag('6000.7.0b3') },
                { name: makeTag('6000.7.0b2', 'linux-il2cpp') }, // wrong module
                { name: makeTag('6000.7.0b3', 'windows-mono', 'windows') }, // wrong OS
                { name: makeTag('6000.7.0b3', 'windows-mono', 'ubuntu', '4') }, // wrong rolling tag
              ],
              next: null,
            },
          }
        : { status: 404 },
    );
    const resolved = await resolveUnityImageFallback(opts(lookup.fetcher));
    expect(resolved).toEqual({
      customImage: `unityci/editor:${makeTag('6000.7.0b3')}`,
      unityVersion: '6000.7.0b3',
    });
    const args = buildCliArgs({
      getInput: (name) =>
        name === 'customImage'
          ? (resolved.customImage ?? '')
          : name === 'unityVersion'
            ? (resolved.unityVersion ?? '')
            : name === 'targetPlatform'
              ? 'StandaloneWindows64'
              : '',
    });
    expect(args).toContain(`--customImage=unityci/editor:${makeTag('6000.7.0b3')}`);
    expect(args).toContain('--engineVersion=6000.7.0b3');
  });

  it('prefers any matching same-minor version over a higher version in another minor', async () => {
    const lookup = registry((url) =>
      url.includes('page_size')
        ? {
            body: {
              results: [{ name: makeTag('6000.6.99f1') }, { name: makeTag('6000.7.0b2') }],
              next: null,
            },
          }
        : { status: 404 },
    );
    const result = await resolveUnityImageFallback(opts(lookup.fetcher));
    expect(result.unityVersion).toBe('6000.7.0b2');
    expect(lookup.calls).toHaveLength(2);
  });

  it('falls back within the same major when the minor has no matching image', async () => {
    const lookup = registry((url) =>
      url.includes('page_size')
        ? {
            body: {
              results: url.includes('6000.7')
                ? [{ name: makeTag('6000.6.9f1', 'windows-mono', 'windows') }]
                : [{ name: makeTag('6000.6.9f1') }, { name: makeTag('6000.5.99f1') }],
              next: null,
            },
          }
        : { status: 404 },
    );
    const result = await resolveUnityImageFallback(opts(lookup.fetcher));
    expect(result.unityVersion).toBe('6000.6.9f1');
    expect(lookup.calls).toHaveLength(3);
  });

  it('handles prerelease versions with patch and stream ordering', async () => {
    const lookup = registry((url) =>
      url.includes('page_size')
        ? {
            body: {
              results: [
                { name: makeTag('6000.7.0a20') },
                { name: makeTag('6000.7.0b3') },
                { name: makeTag('6000.7.0f1') },
                { name: makeTag('6000.7.0b2') },
              ],
              next: null,
            },
          }
        : { status: 404 },
    );
    expect((await resolveUnityImageFallback(opts(lookup.fetcher))).unityVersion).toBe('6000.7.0b3');
  });

  it('uses the ProjectVersion.txt file when no explicit version is passed', async () => {
    const lookup = registry((url) =>
      url.includes('page_size')
        ? { body: { results: [{ name: makeTag('6000.7.0b3') }], next: null } }
        : { status: 404 },
    );
    const result = await resolveUnityImageFallback(
      opts(lookup.fetcher, {
        projectPath: project('6000.7.0b4'),
        unityVersion: 'auto',
      }),
    );
    expect(result.unityVersion).toBe('6000.7.0b3');
  });

  it('handles Android and Linux modules without crossing build targets', async () => {
    const lookup = registry((url) =>
      url.includes('page_size')
        ? {
            body: {
              results: [
                { name: makeTag('6000.7.0b3', 'windows-mono') },
                { name: makeTag('6000.7.0b2', 'android') },
                { name: makeTag('6000.7.0b1', 'linux-il2cpp') },
              ],
              next: null,
            },
          }
        : { status: 404 },
    );
    const android = await resolveUnityImageFallback(
      opts(lookup.fetcher, { targetPlatform: 'Android' }),
    );
    const linux = await resolveUnityImageFallback(
      opts(lookup.fetcher, { targetPlatform: 'StandaloneLinux64' }),
    );
    expect(android.unityVersion).toBe('6000.7.0b2');
    expect(linux.unityVersion).toBe('6000.7.0b1');
  });

  it('matches the Windows Docker platform and IL2CPP module on Windows hosts', async () => {
    const lookup = registry((url) =>
      url.includes('page_size')
        ? {
            body: {
              results: [{ name: makeTag('6000.7.0b3', 'windows-il2cpp', 'windows') }],
              next: null,
            },
          }
        : { status: 404 },
    );
    const result = await resolveUnityImageFallback(opts(lookup.fetcher, { hostPlatform: 'win32' }));
    expect(result.customImage).toBe('unityci/editor:windows-6000.7.0b3-windows-il2cpp-3');
    expect(lookup.calls[0]).toContain('windows-6000.7.0b4-windows-il2cpp-3');
  });

  it('never silently downgrades on a registry error or a network failure', async () => {
    const unavailable = registry(() => ({ status: 503 }));
    expect(await resolveUnityImageFallback(opts(unavailable.fetcher))).toEqual({});
    const broken = registry(() => {
      throw new Error('ETIMEDOUT');
    });
    expect(await resolveUnityImageFallback(opts(broken.fetcher))).toEqual({});
  });

  it('does not select an earlier major version or newer Unity version', async () => {
    const lookup = registry((url) =>
      url.includes('page_size')
        ? {
            body: {
              results: [{ name: makeTag('2022.3.62f1') }, { name: makeTag('6000.8.0b1') }],
              next: null,
            },
          }
        : { status: 404 },
    );
    expect(await resolveUnityImageFallback(opts(lookup.fetcher))).toEqual({});
  });

  it('continues through matching Docker Hub pages and chooses the nearest earlier image', async () => {
    const lookup = registry((url) => {
      if (!url.includes('page_size')) return { status: 404 };
      if (url.includes('page=2'))
        return {
          body: { results: [{ name: makeTag('6000.7.0b3') }], next: null },
        };
      return {
        body: {
          results: [{ name: makeTag('6000.7.0b1') }],
          next: `${root}?page_size=100&page=2`,
        },
      };
    });
    expect((await resolveUnityImageFallback(opts(lookup.fetcher))).unityVersion).toBe('6000.7.0b3');
  });

  it('rejects cross-host pagination links instead of requesting them', async () => {
    const lookup = registry((url) =>
      url.includes('page_size')
        ? { body: { results: [], next: 'https://attacker.test/tags' } }
        : { status: 404 },
    );
    expect(await resolveUnityImageFallback(opts(lookup.fetcher))).toEqual({});
    expect(lookup.calls).toHaveLength(2);
  });
});

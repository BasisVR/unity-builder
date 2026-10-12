# Unity - Builder

(Not affiliated with Unity Technologies)

GitHub Action to
[build Unity projects](https://github.com/marketplace/actions/unity-builder)
for different platforms.

Part of the <a href="https://game.ci">GameCI</a> open source project.
<br />
<br />

[![Builds - Ubuntu](https://github.com/game-ci/unity-builder/actions/workflows/build-tests-ubuntu.yml/badge.svg)](https://github.com/game-ci/unity-builder/actions/workflows/build-tests-ubuntu.yml)
[![Builds - Windows](https://github.com/game-ci/unity-builder/actions/workflows/build-tests-windows.yml/badge.svg)](https://github.com/game-ci/unity-builder/actions/workflows/build-tests-windows.yml)
[![Builds - MacOS](https://github.com/game-ci/unity-builder/actions/workflows/build-tests-mac.yml/badge.svg)](https://github.com/game-ci/unity-builder/actions/workflows/build-tests-mac.yml)
[![codecov - test coverage](https://codecov.io/gh/game-ci/unity-builder/branch/master/graph/badge.svg)](https://codecov.io/gh/game-ci/unity-builder)
<br />
<br />

## How to use

Find the
[docs](https://game.ci/docs/github/builder)
on the GameCI
[documentation website](https://game.ci/docs).

## BasisVR: Unity image version fallback (GameCI v6)

This fork preserves BasisVR's v4-style Docker image fallback on top of the
upstream v6 CLI wrapper. When the exact official `unityci/editor` image is
missing (Docker Hub returns HTTP 404), the action looks for the highest
compatible **earlier Unity editor version**, preferring the same minor
version, then the same major version. The Docker platform, build module and
rolling image revision must match.

The selected fallback is passed to `game-ci build` as **both**
`--customImage` and `--engineVersion`, so the actual Unity editor
version and Docker image stay consistent. The action keeps the requested
version when the exact tag exists or when Docker Hub is unavailable; it
does not silently downgrade on registry errors.

Fallback is automatic for locally executed Docker builds using an official
`unityci/*` registry image. It is **not** applied to a supplied
`customImage`, non-Docker/macOS builds, or `providerStrategy=local-system`.
In particular, BasisVR's custom-built `basis-unity-editor` CI images are
left unchanged.

Unity 6.6+ requires more shared memory than Docker's 64 MiB default.
Upstream GameCI CLI defaults to `1025m`; you may explicitly configure
`dockerShmSize: 2g` for extra headroom.

```yaml
- uses: Toys0125/unity-builder@upgrade/game-ci-v6.0.0
  with:
    projectPath: Basis
    targetPlatform: StandaloneWindows64
    dockerShmSize: 2g
```

The original upstream v6 action runs on Node 24 and downloads the
`game-ci/cli` binary. These behaviors remain unchanged.

## Related actions

Visit the
GameCI <a href="https://github.com/game-ci/unity-actions">Unity Actions</a>
status repository for related Actions.

## Community

Feel free to join us on
<a href="http://game.ci/discord"><img height="30" src="media/Discord-Logo.svg" alt="Discord" /></a>
and engage with the community.

## Contributing

To help improve the documentation, please find the docs [repository](https://github.com/game-ci/documentation).

To contribute to Unity Builder, kindly read the [contribution guide](./CONTRIBUTING.md).

## Support us

GameCI is free for everyone forever.

You can support us at [OpenCollective](https://opencollective.com/game-ci).

## Licence

This repository is [MIT](./LICENSE) licensed.

This includes all contributions from the community.

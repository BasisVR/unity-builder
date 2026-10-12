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

## Unity editor image version fallback

For local Docker builds using official `unityci/*` editor images, the action
checks whether the requested image tag exists on Docker Hub. If the tag
returns HTTP 404, it searches for the closest **older compatible Unity
editor version** in the same minor version, then the same major version.
The Docker platform, build module, and image revision must match.

The selected image and editor version are passed together to the
`game-ci build` CLI as `--customImage` and `--engineVersion`.
An existing tag is never replaced. Registry errors or unavailable lookup
results leave the originally requested version unchanged.

Fallback is skipped when `customImage` is set, when running on macOS,
or for non-Docker providers such as `providerStrategy=local-system`.
Custom-built editor images are therefore unaffected.

## Docker shared memory

The GameCI CLI defaults Docker shared memory to `1025m`. For projects
that require more, set the `dockerShmSize` action input explicitly:

```yaml
# After merging into BasisVR/unity-builder:
- uses: BasisVR/unity-builder@main
  with:
    projectPath: MyUnityProject
    targetPlatform: StandaloneWindows64
    dockerShmSize: 2g
```

The action continues to run on Node 24 and delegates builds to the
`game-ci/cli` binary.

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

import BuildParameters from '../../build-parameters';
import UnityImageResolver from '../services/core/unity-image-resolver';

describe('UnityImageResolver', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('selects the closest lower Unity minor version', () => {
    const requestedVersion = '2022.3.20f1';
    const availableVersions = ['2022.3.19f1', '2022.2.21f1', '2021.3.33f1', '2022.1.24f1'];

    const fallback = UnityImageResolver.selectClosestLowerMinorVersion(requestedVersion, availableVersions);

    expect(fallback).toStrictEqual('2022.2.21f1');
  });

  it('returns undefined when only same-minor patch versions exist', () => {
    const requestedVersion = '2022.3.20f1';
    const availableVersions = ['2022.3.19f1', '2022.3.18f1'];

    const fallback = UnityImageResolver.selectClosestLowerMinorVersion(requestedVersion, availableVersions);

    expect(fallback).toBeUndefined();
  });

  it('falls back to a lower minor image when exact tag does not exist', async () => {
    const buildParameters = {
      customImage: '',
      containerRegistryRepository: 'unityci/editor',
      editorVersion: '2022.3.20f1',
    } as BuildParameters;

    jest.spyOn(UnityImageResolver, 'doesDockerHubTagExist').mockResolvedValue(false);
    jest
      .spyOn(UnityImageResolver, 'listMatchingUnityVersions')
      .mockResolvedValue(['2022.2.21f1', '2021.3.33f1', '2022.3.19f1']);

    const result = await UnityImageResolver.resolveImage(
      buildParameters,
      'unityci/editor:ubuntu-2022.3.20f1-linux-il2cpp-3',
    );

    expect(result.image).toStrictEqual('unityci/editor:ubuntu-2022.2.21f1-linux-il2cpp-3');
    expect(result.editorVersion).toStrictEqual('2022.2.21f1');
  });

  it('keeps the original image when exact tag exists', async () => {
    const buildParameters = {
      customImage: '',
      containerRegistryRepository: 'unityci/editor',
      editorVersion: '2022.3.20f1',
    } as BuildParameters;

    jest.spyOn(UnityImageResolver, 'doesDockerHubTagExist').mockResolvedValue(true);

    const result = await UnityImageResolver.resolveImage(
      buildParameters,
      'unityci/editor:ubuntu-2022.3.20f1-linux-il2cpp-3',
    );

    expect(result.image).toStrictEqual('unityci/editor:ubuntu-2022.3.20f1-linux-il2cpp-3');
    expect(result.editorVersion).toStrictEqual('2022.3.20f1');
  });

  it('skips resolution for non-unityci repositories', async () => {
    const buildParameters = {
      customImage: '',
      containerRegistryRepository: 'my-company/editor',
      editorVersion: '2022.3.20f1',
    } as BuildParameters;

    const tagExistsSpy = jest.spyOn(UnityImageResolver, 'doesDockerHubTagExist').mockResolvedValue(false);

    const result = await UnityImageResolver.resolveImage(
      buildParameters,
      'my-company/editor:ubuntu-2022.3.20f1-linux-il2cpp-3',
    );

    expect(result.image).toStrictEqual('my-company/editor:ubuntu-2022.3.20f1-linux-il2cpp-3');
    expect(tagExistsSpy).not.toHaveBeenCalled();
  });
});

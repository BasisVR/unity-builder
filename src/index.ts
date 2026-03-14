import * as core from '@actions/core';
import { Action, BuildParameters, Cache, Orchestrator, Docker, ImageTag, Output } from './model';
import { Cli } from './model/cli/cli';
import MacBuilder from './model/mac-builder';
import PlatformSetup from './model/platform-setup';
import UnityImageResolver from './model/orchestrator/services/core/unity-image-resolver';

async function runMain() {
  try {
    if (Cli.InitCliMode()) {
      await Cli.RunCli();

      return;
    }
    Action.checkCompatibility();
    Cache.verify();

    const { workspace, actionFolder } = Action;

    const buildParameters = await BuildParameters.create();
    const baseImage = new ImageTag(buildParameters);

    let exitCode = -1;

    if (buildParameters.providerStrategy === 'local') {
      core.info('Building locally');
      await PlatformSetup.setup(buildParameters, actionFolder);
      const resolvedImage = await UnityImageResolver.resolveImage(buildParameters, baseImage.toString());
      if (buildParameters.editorVersion !== resolvedImage.editorVersion) {
        buildParameters.editorVersion = resolvedImage.editorVersion;
      }
      exitCode =
        process.platform === 'darwin'
          ? await MacBuilder.run(actionFolder)
          : await Docker.run(resolvedImage.image, {
              workspace,
              actionFolder,
              ...buildParameters,
            });
    } else {
      await Orchestrator.run(buildParameters, baseImage.toString());
      exitCode = 0;
    }

    // Set output
    await Output.setBuildVersion(buildParameters.buildVersion);
    await Output.setAndroidVersionCode(buildParameters.androidVersionCode);
    await Output.setEngineExitCode(exitCode);

    if (exitCode !== 0) {
      core.setFailed(`Build failed with exit code ${exitCode}`);
    }
  } catch (error) {
    core.setFailed((error as Error).message);
  }
}

runMain();

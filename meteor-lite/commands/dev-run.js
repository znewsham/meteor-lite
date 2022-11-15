import { spawn } from 'child_process';
import path from 'path';
import fsExtra from 'fs-extra';
import { baseBuildFolder } from './helpers/command-helpers';
import generateServer, { generateConfigJson } from '../build-run/server/generate-server';
import generateWebBrowser from '../build-run/client/generate-web-browser';
import watchPackages from '../conversion/watch-packages';

class AppProcess {
  #testMetadata;

  #archs;

  #nodeArgs;

  static #constantNodeArgs = [
    '--no-wasm-code-gc', // HACK - maybe removable after we move to thread based fibers, maybe not at all
    '--experimental-specifier-resolution=node',
    '--conditions=development',
  ];

  constructor(archs, { testMetadata, nodeArgs = [] } = {}) {
    this.#archs = archs;
    this.#testMetadata = testMetadata;
    this.#nodeArgs = nodeArgs;
  }

  async restartServer() {
    this.process.removeAllListeners('close');
    this.process.removeAllListeners('error');
    const died = new Promise((resolve) => {
      this.process.on('exit', () => {
        resolve();
      });
    });
    this.process.kill();
    this.process = undefined;
    await died;
    await this.spawn();
  }

  async pauseClient(arch) {
    if (!this.process) {
      return false;
    }
    await this.process.sendMessage('webapp-pause-client', { arch });
    return true;
  }

  async rebuildProgram() {
    return generateConfigJson({
      archs: this.#archs,
    });
  }

  async refreshClient(arch) {
    if (!this.process) {
      return;
    }
    if (typeof arch === 'string') {
      // This message will reload the client program and unpause it.
      await this.process.sendMessage('webapp-reload-client', { arch });
    }
    // If arch is not a string, the receiver of this message should
    // assume all clients need to be refreshed.
    await this.process.sendMessage('client-refresh');
  }

  #getTestMetadata() {
    if (!this.#testMetadata) {
      return '{}';
    }
    return JSON.stringify(this.#testMetadata);
  }

  async spawn() {
    const shellDir = process.env.METEOR_SHELL_DIR || path.resolve(path.join(baseBuildFolder, 'shell'));
    await fsExtra.ensureDir(shellDir);
    const ipc = await AppProcess.LoadInterProcessMessaging();
    process.chdir('.meteor/local/server/'); // only needed (arguably) for @qualia:prod-shell otherwise it writes to the actual app dir
    this.process = spawn(
      'node',
      [
        ...this.#nodeArgs,
        ...AppProcess.#constantNodeArgs,
        'main.js',
        'config.json',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          METEOR_SHELL_DIR: shellDir,
          ...process.env,
          NODE_ENV: 'development',
          TEST_METADATA: this.#getTestMetadata(),
        },
      },
    );
    ipc.enable(this.process);
    this.process.stdout.on('data', (data) => {
      process.stdout.write(data);
    });

    this.process.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    this.process.on('close', (code, signal) => {
      console.log('Process exited', code, signal);
    });
  }

  static async LoadInterProcessMessaging() {
    // these probably don't "need" to be dynamic anymore, but since this is the package that builds thes
    // it seems prudent to make them dynamic (so we can build them if they don't exist)
    await import('@meteor/modern-browsers');
    return import('@meteor/inter-process-messaging');
  }
}

export default async function run(
  archs,
  {
    buildAndWatchPackages,
    job,
    watchAll = false,
    testMetadata,
    inspect,
    inspectBrk,
  } = {},
) {
  const nodeArgs = [];
  if (inspectBrk) {
    nodeArgs.push(`--inspect-brk${inspectBrk === true ? '' : `=${inspectBrk}`}`);
  }
  else if (inspect) {
    nodeArgs.push(`--inspect${inspect === true ? '' : `=${inspect}`}`);
  }
  const appProcess = new AppProcess(
    archs,
    {
      testMetadata,
      nodeArgs
    },
  );

  if (buildAndWatchPackages) {
    watchPackages(job, { watchAll });
  }

  let start = new Date().getTime();
  await Promise.all(archs.map((archName) => generateWebBrowser(
    archName,
    {
      appProcess,
      isProduction: false,
      outputBuildFolder: baseBuildFolder,
    },
  )));
  console.log('web browser', (new Date().getTime() - start) / 1000);
  start = new Date().getTime();
  await generateServer(
    archs,
    {
      appProcess,
      isProduction: false,
      outputBuildFolder: baseBuildFolder,
    },
  );
  console.log('server', (new Date().getTime() - start) / 1000);
  await appProcess.spawn();
  return appProcess;
}

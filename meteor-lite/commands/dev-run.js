import { spawn } from 'child_process';
import path from 'path';
import fsExtra from 'fs-extra';
import { baseBuildFolder } from './helpers/command-helpers';
import generateServer, { generateConfigJson } from './helpers/generate-server';
import generateWebBrowser from './helpers/generate-web-browser';
import watchPackages from './helpers/watch-packages';

class AppProcess {
  constructor(archs) {
    this.archs = archs;
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
      archs: this.archs,
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

  async spawn() {
    const shellDir = process.env.METEOR_SHELL_DIR || path.resolve(path.join(baseBuildFolder, 'shell'));
    await fsExtra.ensureDir(shellDir);
    const ipc = await AppProcess.LoadInterProcessMessaging();
    this.process = spawn(
      'node',
      [
        '--inspect=0.0.0.0:9229',
        '--no-wasm-code-gc', //TODO  hack
        '--experimental-specifier-resolution=node',
        '--conditions=development',
        '.meteor/local/server/main.js',
        '.meteor/local/server/config.json',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          METEOR_SHELL_DIR: shellDir,
          ...process.env,
          NODE_ENV: 'development',
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

export default async function run(archs, { buildAndWatchPackages, job } = {}) {
  const appProcess = new AppProcess(archs);

  if (buildAndWatchPackages) {
    watchPackages(job);
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

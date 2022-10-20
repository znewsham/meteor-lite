import { spawn } from 'child_process';
import path from 'path';
import fsExtra from 'fs-extra';
import { baseBuildFolder } from '../helpers/command-helpers';
import generateServer, { generateConfigJson } from './generate-server';
import generateWebBrowser from './generate-web-browser';

class AppProcess {
  constructor(archs) {
    this.archs = archs;
  }

  async restartServer() {
    this.process.removeAllListeners('close');
    this.process.removeAllListeners('error');
    this.process.kill();
    await this.spawn();
  }

  async pauseClient(arch) {
    if (!this.process) {
      return undefined;
    }
    return this.process.sendMessage('webapp-pause-client', { arch });
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
    const shellDir = path.resolve(path.join(baseBuildFolder, 'shell'));
    await fsExtra.ensureDir(shellDir);
    const ipc = await AppProcess.LoadInterProcessMessaging();
    this.process = spawn(
      'node',
      [
        '--inspect',
        '--no-wasm-code-gc', //TODO  hack
        '--experimental-specifier-resolution=node',
        '.meteor/local/server/main.js',
        '.meteor/local/server/config.json',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          METEOR_SHELL_DIR: shellDir,
          ...process.env,
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
    return import('@meteor/inter-process-messaging');
  }
}

export default async function run(archs) {
  const appProcess = new AppProcess(archs);
  await Promise.all(archs.map((archName) => generateWebBrowser(archName, { appProcess })));
  await generateServer(archs, { appProcess });
  await appProcess.spawn();
  return appProcess;
}

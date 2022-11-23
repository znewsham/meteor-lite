import util from 'util';
import { exec } from 'child_process';

const asyncExec = util.promisify(exec);

export default async function npmInstall() {
  await asyncExec('npm install');
}

import os from 'os';
import path from 'path';
import ensureLocalPackageFn from '../helpers/ensure-local-package';

export default async function ensureLocalPackage({
  name,
  version,
  meteorInstall = path.join(os.homedir(), '.meteor'),
}) {
  return ensureLocalPackageFn({ name, version, meteorInstall });
}

import fsPromises from 'fs/promises';
import { listFilesInDir } from './helpers/command-helpers';

const excludes = new Set(['pre-boot.js', 'main.js', 'dependencies.js']);

export default async function buildMain({ env, update }) {
  const res = [
    ...(await listFilesInDir('lib', 'depth')).map((file) => `../${file}`),
    ...(await listFilesInDir(env, 'depth'))
      .map((file) => file.split('/').slice(1).join('/'))
      .filter((file) => !excludes.has(file))
      .map((file) => `./${file}`),
  ];

  if (update) {
    await fsPromises.writeFile(
      `./${env}/main.js`,
      [
        'import "./dependencies.js"',
        ...res.map((file) => `import "${file}";`),
      ].join('\n'),
    );
  }
  else {
    console.log(res);
  }
}

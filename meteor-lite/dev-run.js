import { spawn } from 'child_process';

export default async function run() {
  console.log('starting up', new Date());
  const node = spawn(
    'node',
    [
      '--inspect',
      '--experimental-specifier-resolution=node',
      '.meteor/local/server/main.js',
      '.meteor/local/server/config.json',
    ],
  );
  node.stdout.on('data', (data) => {
    process.stdout.write(data);
  });

  node.stderr.on('data', (data) => {
    process.stderr.write(data);
  });

  node.on('close', (code) => {
    process.exit(code);
  });
}

import colors from 'colors';

export function notify(...msg) {
  console.log(colors.green(msg.join(' ')));
}

export function error(...err) {
  console.error(colors.red(err.join(' ')));
}

export function warn(...warning) {
  console.warn(colors.yellow(warning.join(' ')));
}

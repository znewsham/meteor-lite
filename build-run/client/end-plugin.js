export default function onEnd(onEndHandler, weakMap) {
  return {
    name: 'on-end',
    setup(build) {
      build.onEnd((...args) => {
        const arch = build.initialOptions.conditions.slice(-1)[0];
        const start = weakMap.get(arch);
        console.log('build ended', arch, build.initialOptions.entryPoints, (new Date().getTime() - start.getTime()) / 1000);
        if (onEndHandler) {
          onEndHandler(build, ...args);
        }
      });
    },
  };
}

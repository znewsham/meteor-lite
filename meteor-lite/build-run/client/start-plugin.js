export default function onStart(onStartHandler, weakMap) {
  return {
    name: 'on-start',
    setup(build) {
      build.onStart((...args) => {
        const arch = build.initialOptions.conditions.slice(-1)[0];
        console.log('build started', arch, build.initialOptions.entryPoints);
        weakMap.set(arch, new Date());
        if (onStartHandler) {
          onStartHandler(build, ...args);
        }
      });
    },
  };
}

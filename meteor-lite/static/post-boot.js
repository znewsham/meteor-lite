import Fiber from 'fibers';
import { getMain, WebApp } from '@meteor/webapp';

function callStartupHooks() {
  // run the user startup hooks.  other calls to startup() during this can still
  // add hooks to the end.
  while (__meteor_bootstrap__.startupHooks.length) {
    const hook = __meteor_bootstrap__.startupHooks.shift();
    hook();
  }
  // Setting this to null tells Meteor.startup to call hooks immediately.
  __meteor_bootstrap__.startupHooks = null;
}

function runMain() {
  const globalMain = Promise.await(getMain());
  // find and run main()
  // XXX hack. we should know the package that contains main.
  const exitCode = globalMain.call({}, process.argv.slice(3));
  // XXX hack, needs a better way to keep alive
  if (exitCode !== 'DAEMON') process.exit(exitCode);
}

Fiber(() => {
  callStartupHooks();
  runMain();
}).run();

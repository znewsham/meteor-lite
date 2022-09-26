import path from 'path';
import fs from 'fs';
import { createHook }  from 'async_hooks';
import Fiber from 'fibers';

const map = {};

const AsyncHook = createHook({
  init(asyncId, type, triggerAsyncId, resource) {
    map[asyncId] = {
      type, asyncId,
      triggerAsyncId, resource
    };
  },
  // before() is called just before the resource's callback is called. It can be
  // called 0-N times for handles (such as TCPWrap), and will be called exactly 1
  // time for requests (such as FSReqCallback).
  before(asyncId) {
    const item = map[asyncId];
    if (!item) {
      return;
    }
    if (item.type === 'Fiber') {
      debugger;
    }
  },

  // after() is called just after the resource's callback has finished.
  after(asyncId) {
    const item = map[asyncId];
    if (!item) {
      return;
    }
    if (item.type === 'Fiber') {
      debugger;
    }
  },

  // destroy() is called when the resource is destroyed.
  destroy(asyncId) {
    const item = map[asyncId];
    if (!item) {
      return;
    }
    if (item.type === 'Fiber') {
      debugger;
    }
  }
});

// AsyncHook.enable();

global.__meteor_runtime_config__ = {};
var serverJsonPath = path.resolve('./server/config.json');
var serverDir = path.dirname(serverJsonPath);
var configJson =
  JSON.parse(fs.readFileSync(path.resolve(serverDir, 'config.json'), 'utf8'));

global.__meteor_bootstrap__ = {
  startupHooks: [],
  serverDir: serverDir,
  configJson: configJson
};

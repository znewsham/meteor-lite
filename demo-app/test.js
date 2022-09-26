import './boot.js';
import { executionAsyncId, triggerAsyncId } from 'async_hooks';
import { Mongo } from '@meteor/mongo';
import { Meteor } from '@meteor/meteor';
import './post-boot.js';
import Fiber from 'fibers';

//WebApp.clientPrograms['web.browser'];
const promise = new Promise((resolve) => {
  setTimeout(resolve, 5000);
});
const ev = new Meteor.EnvironmentVariable();
function doit(collection, n) {
  ev.withValue(n, () => {
    const et1 = executionAsyncId();
    collection.findOne();
    const et2 = executionAsyncId();
    collection.findOne();
    const et3 = executionAsyncId();
    if (et1 !== et2 || et2 !== et3 || ev.get() !== n) {
      console.error("BAD", n, et1, et2, et3, ev.get());
    }
    else {
    }
  });
}

let fiber = new Fiber(() => {
  const collection = new Mongo.Collection('users');
  console.log("init", executionAsyncId(), triggerAsyncId());
  new Array(1000).fill().map((_, i) => new Fiber(() => doit(collection, i)).run());
  const et1 = executionAsyncId();
  collection.findOne();
  const et2 = executionAsyncId();
  collection.findOne();
  const et3 = executionAsyncId();
  if (et1 !== et2 || et2 !== et3) {
    console.error("BAD", 0, et1, et2, et3);
  }
  fiber = null;
}).run();


import './boot.js';
import "@meteor/meteor-base";
import "@meteor/mobile-experience";
import { Mongo } from "@meteor/mongo";
import "@meteor/blaze-html-templates";
import "@meteor/jquery";
import "@meteor/reactive-var";
import "@meteor/tracker";

import "@meteor/es5-shim";
import "@meteor/shell-server";

import "@meteor/autopublish";
import "@meteor/insecure";

import './post-boot.js';

import Fiber from 'fibers';

new Fiber(() => {
  console.log('here');
  const collection = new Mongo.Collection('test');
  collection.insert({
    dummy: 'document'
  });
  console.log('here');
}).run();

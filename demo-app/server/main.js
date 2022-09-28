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

import "@meteor/oauth";

import Fiber from 'fibers';

new Fiber(() => {
  const collection = new Mongo.Collection('test');
}).run();

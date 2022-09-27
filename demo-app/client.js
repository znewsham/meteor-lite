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


globalThis.collection = new Mongo.Collection('test')

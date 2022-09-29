import "./dependencies.js";

import { Mongo } from "@meteor/mongo";
import Fiber from 'fibers';

new Fiber(() => {
  const collection = new Mongo.Collection('test');
}).run();

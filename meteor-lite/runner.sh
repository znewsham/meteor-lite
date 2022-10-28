#!/usr/bin/env sh
DIR="$(dirname "$(readlink -f "$0")")"

node --experimental-specifier-resolution=node $DIR/runner.js $@

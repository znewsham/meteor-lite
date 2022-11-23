#!/usr/bin/env sh
DIR="$(dirname "$(readlink -f "$0")")"

node $TOOL_NODE_OPTIONS --experimental-specifier-resolution=node $DIR/runner.js $@

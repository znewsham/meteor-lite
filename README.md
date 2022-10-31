
# Proof of concept
1. Ensure you're on linux
2. Ensure you're on node 14.20.0 (or thereabouts)
3. Run the below to get started (no OTF rebuilds, kill and reup when you want)

```bash
git clone https://github.com/znewsham/meteor-to-node
git clone --branch make-compatible https://github.com/znewsham/blaze
git clone --branch make-compatible https://github.com/znewsham/meteor

cd ./meteor-to-node/meteor-lite && npm install
```

visit http://localhost:3000 and feast your eyes on your non-meteor meteor app. Try `collection.insert({...})` or `collection.findOne()` (literally `collection`), play with the counter button. Observer the websocket.

## More details
The meteor-lite project (and the runner.js file specifically) offer a few commands, all commands should be ran with `node --experimental-specifier-resolution=node`

The goal is for these commands to be deprecated as soon as we've finished converting our apps. At which point we just maintain the node modules. As such the (extremely fast for a very naive approach) build time is a "one time" (read 4000 times while we do the conversion) cost. The app should start up *extremely* quickly.

### convert-packages
`runner.js convert-packages -p blaze oauth -d ../meteor/packages ../blaze/packages -p ./packages`

Convert the blaze and oauth meteor packages and their dependencies. They will be found in either in `../meteor/pacakges` or `../blaze/packages`. The resulting NPM packages should be put in `./packages`.

### convert-deps
`runner.js convert-packages -d ../meteor/packages ../blaze/packages -p ./packages -u`

Take the meteor dependencies (as specified by .meteor/packages) and convert them to node packages as with `convert-packages`. In addition, if the `-u` flag is set, update the `server/dependencies.js` and `client/dependencies.js` with the (now explicit) list of imports. Also setup true globals.

### dev-build
`runner.js dev-build`

Generate the web.browser and server architectures (spoiler, server arch is basically just sym linking + some static bootstrap stuff). And dump the contents into .meteor/local

### dev-run
`runner.js dev-run`

Generates the architectures as with `dev-build` - then runs the node command:
```node --experimental-specifier-resolution=node .meteor/local/server/main.js .meteor/local/server/config.json```

This is very similar to what meteor does in production, made so intentionally. In the future we can add file watchers to restart this command on file change.

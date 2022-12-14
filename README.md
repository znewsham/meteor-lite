
# Proof of concept
1. Ensure you're on linux
2. Ensure you're on node 14.20.0 (or thereabouts)
3. Run the below to get started

```bash
git clone https://github.com/qualialabs/meteor-lite
git clone --branch make-compatible https://github.com/qualialabs/blaze
git clone --branch make-compatible https://github.com/qualialabs/meteor

cd ./meteor-lite && npm install

# these are only required if you don't have access to the qualia verdaccio instance
runner.sh convert-packages \
  -d ../meteor/packages/ ../meteor/packages/non-core/ ../meteor/packages/deprecated/ ../blaze/packages/ \
  -o npm-packages \
  -p modern-browsers templating-tools inter-process-messaging package-version-parser constraint-solver

runner.sh write-peer-dependencies \
  -o npm-packages/ -t optionalDependencies

npm install
```

From within a meteor app you can now run the following commands:
```
# convert all meteor packages to npm packages. If the module is available through NPM already (e.g., through a configured private NPM registry) it will be skipped and the remote version will be used
METEOR_PACKAGE_DIRS=.common runner.sh convert-deps \
  -d ../meteor/packages/ ../meteor/packages/non-core ../meteor/packages/deprecated/ ../blaze/packages/ \
  -m /home/vagrant/share/meteor/.meteor/ \
  -o npm-packages/ \
  --outputLocalDirectory npm-packages-local \
  --outputSharedDirectory npm-packages-shared \
  -u

# update package.json with the app dependencies and any local packages, write a meteor-peer-dependencies module with all other dependencies
runner.sh write-peer-dependencies \
  -o npm-packages npm-packages-local npm-packages-shared

# if you don't already have a mainModule this will generate a server/main.js and client/main.js respectively
runner.sh generate-main
  -e server
  -u

runner.sh generate-main
  -e client
  -u

# run the app in dev mode (non-minified)
runner.sh dev-run
```

## More details
The meteor-lite project (and the runner.js file specifically) offer a few commands, all commands should be ran with `node --experimental-specifier-resolution=node`. If you install the binary you can just run `meteor-lite` and not worry about the options

The goal is for these commands to be deprecated as soon as we've finished converting our apps. At which point we just maintain the node modules. As such the (extremely fast for a very naive approach) build time is a "one time" (read 4000 times while we do the conversion) cost. The app should start up *extremely* quickly.

### convert-packages
`meteor-lite convert-packages -p blaze oauth -d ../meteor/packages ../meteor/packages/non-core ../meteor/packages/deprecated ../blaze/packages -p ./npm-packages`

Convert the blaze and oauth meteor packages and their dependencies. They will be found in either in `../meteor/packages` (or one of it's sub folders) or `../blaze/packages`. The resulting NPM packages should be put in `./npm-packages`.

If the local source of a package is not available, but meteor is installed, it will pull from the ISO pack

### convert-deps
`runner.js convert-deps -d ../meteor/packages ../blaze/packages -p ./packages -u`

Take the meteor dependencies (as specified by .meteor/packages) and convert them to node packages as with `convert-packages`. In addition, if the `-u` flag is set, update the `server/dependencies.js` and `client/dependencies.js` with the (now explicit) list of imports. Also setup true globals.

This will also use meteor's constraint solver to convert the correct package versions

### dev-build
`runner.js dev-build`

Generate the web.browser and server architectures (spoiler, server arch is basically just sym linking + some static bootstrap stuff). And dump the contents into .meteor/local

### dev-run
`runner.js dev-run`

Generates the architectures as with `dev-build` - then runs the node command:
```node --experimental-specifier-resolution=node .meteor/local/server/main.js .meteor/local/server/config.json```

This is very similar to what meteor does in production, made so intentionally. In the future we can add file watchers to restart this command on file change.

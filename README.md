./install.sh

./node_modules/.bin/esbuild --bundle client.js --outfile=web.browser/app.js --define:Meteor.isServer=false --define:__package_globals.require=require --sourcemap

PORT=3000 MONGO_URL='mongodb://127.0.0.1:27017/qualia' ROOT_URL='http://localhost:3000' node --experimental-specifier-resolution=node server.js

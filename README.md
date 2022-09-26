node convert-to-npm.mjs <path to meteor clone>/packages/mongo/ demo-app/packages/

PORT=3000 MONGO_URL='mongodb://127.0.0.1:27017/qualia' ROOT_URL='http://localhost:3000' node --experimental-vm-modules --experimental-specifier-resolution=node test.js

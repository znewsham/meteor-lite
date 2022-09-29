
```bash
git clone https://github.com/znewsham/meteor-to-node
git clone --branch make-compatible https://github.com/znewsham/blaze
git clone --branch make-compatible https://github.com/znewsham/meteor

cd ./meteor-to-node/meteor-lite && npm install
cd ../demo-app && npm install && npm install ./meteor #this is a local symlink to make importing meteor/package easier.
npm start
```

visit http://localhost:3000 and feast your eyes on your non-meteor meteor app.

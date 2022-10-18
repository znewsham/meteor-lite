import split from 'split2';
import pipe from 'multipipe';
import { Transform } from 'stream';

export function transform(callback) {
  const splitStream = split(/\r?\n/, null, {
    trailing: false,
  });
  const actualTransform = new Transform();
  actualTransform._transform = async function _transform(chunk, _encoding, done) {
    let line = chunk.toString('utf8');
    try {
      line = await callback(line);
    }
    catch (error) {
      done(error);
      return;
    }
    done(null, line);
  };
  return pipe(splitStream, actualTransform);
}

export function eachline(stream, callback) {
  stream.pipe(transform(callback));
}

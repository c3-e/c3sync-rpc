const net = require('net');
const path = require('path');
const spawn = require('child_process').spawn;

const PARENTS = 8;
const PARENT_SRC = `
const client = require(${JSON.stringify(path.join(__dirname, '..'))})(
  ${JSON.stringify(path.join(__dirname, '..', 'test-worker.js'))}, 'concurrent');
process.stdout.write(String(client('ppid') === process.pid));
process.exit(0);
`;

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer().listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function runParent(port) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['-e', PARENT_SRC], {
      env: Object.assign({}, process.env, {
        NODE_OPTIONS: '--require ' + path.join(__dirname, '..', 'test-fixed-port.js'),
        SYNC_RPC_TEST_FIXED_PORT: String(port),
      }),
    });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', code => resolve(out + ' exit=' + code));
  });
}

test('concurrent starts each talk to their own worker', () => {
  return freePort()
    .then(port => Promise.all(Array.from({length: PARENTS}, () => runParent(port))))
    .then(results => expect(results).toEqual(Array(PARENTS).fill('true exit=0')));
}, 120000);

'use strict';

const net = require('net');
const JSON = require('./json-buffer');

const INIT = 1;
const CALL = 0;
const modules = [];
const index = [0];

const NULL_PROMISE = Promise.resolve(null);
const server = net.createServer({allowHalfOpen: true}, c => {
  let responded = false;
  function respond(data) {
    if (responded) return;
    responded = true;
    c.end(JSON.stringify(data));
  }

  let buffer = '';
  c.on('error', function(err) {
    respond({s: false, v: {code: err.code, message: err.message}});
  });
  c.on('data', function(data) {
    buffer += data.toString('utf8');
    if (/\r\n/.test(buffer)) {
      onMessage(buffer.trim());
    }
  });
  function onMessage(str) {
    index[0] = index[0] + 1;
    console.log(`received msg #${index[0]} at server: ${str}`);
    if (str === 'ping') {
      c.end('pong');
      return;
    }
    NULL_PROMISE.then(function() {
      const req = JSON.parse(str);
      if (req.t === INIT) {
        return init(req.f, req.a);
      }
      console.log(`sending msg #${index[0]} to c3server.`);
      return modules[req.i](req.a);
    }).then(
      function(response) {
        console.log(`sending response #${index[0]} to local client.`);
        respond({s: true, v: response});
        console.log(`sent response #${index[0]} to local client.`);
      },
      function(err) {
        console.error(`error: ${err.message} in local server.`);
        respond({s: false, v: {code: err.code, message: err.message}});
      }
    );
  }
});

function init(filename, arg) {
  let m = require(filename);
  if (m && typeof m === 'object' && typeof m.default === 'function') {
    m = m.default;
  }
  if (typeof m !== 'function') {
    throw new Error(filename + ' did not export a function.');
  }
  return NULL_PROMISE.then(function() {
    return m(arg);
  }).then(function(fn) {
    const i = modules.length;
    modules[i] = fn;
    return i;
  });
}

server.listen(+process.argv[2]);

'use strict';

const net = require('net');
const JSON = require('./json-buffer');
const fs = require('fs');
const READFILETIMELIMIT = 30000;

const debugMode = false;

function responseFileReadyForWriting(filePath) {
  return !fs.existsSync(filePath);
}

function timeLimitExceeded(startTime) {
  return startTime + READFILETIMELIMIT < Date.now();
}

function writeResponseToFile(filePath, response) {
  const startTime = Date.now();
  while (!responseFileReadyForWriting(filePath)) {
    // if (timeLimitExceeded(startTime)) {
    //   fs.unlinkSync(filePath);
    //   writeResponseToFile(filePath, JSON.stringify({s: false, v: {code: -1, message: "Response file waiting to write for > 30s in worker thread in sync-rpc."}}));
    // }
  }
  fs.writeFileSync(filePath, response);
  debugMode && console.log(`Written response to file.`);
  fs.chmodSync(filePath, '444');
  debugMode && console.log(`Changed response file to readonly.`);
}

function writeResponseContent(filePath, content) {
  const startTime = Date.now();
  while (!responseFileReadyForWriting(filePath)) {
    if (timeLimitExceeded(startTime)) {
      fs.unlinkSync(filePath);
      writeResponseContent(filePath, JSON.stringify({s: false, v: {code: -1, message: "Response content file waiting to write for > 30s in worker thread in sync-rpc."}}));
    }
  }
  fs.writeFileSync(filePath, content, {encoding: 'binary'});
  debugMode && console.log(`Written content to file.`);
  fs.chmodSync(filePath, '444');
  debugMode && console.log(`Changed content file to readonly.`);
}

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
      buffer = '';
    }
  });
  function onMessage(str) {
    index[0] = index[0] + 1;
    debugMode && console.log(`received msg #${index[0]} at server: ${str}`);
    if (str === 'ping') {
      c.end('pong');
      return;
    }
    const req = JSON.parse(str);
    NULL_PROMISE.then(function() {
      if (req.t === INIT) {
        return init(req.f, req.a);
      }
      debugMode && console.log(`sending msg #${index[0]} to c3server.`);
      return modules[req.i](req.a);
    }).then(
      function(response) {
        debugMode && console.log(`sending response #${index[0]} to local client.`);
        if (req.client != 'ready') {
          respond({s: true, v: response});
        } else {
          const responseContentPath = req.responseFilePath.split('.')[0];
          writeResponseContent(responseContentPath, response.b);
          response.b = responseContentPath;
          writeResponseToFile(req.responseFilePath, JSON.stringify({s: true, v: response}));
        }
        debugMode && console.log(`sent response #${index[0]} to local client.`);
      },
      function(err) {
        debugMode && console.error(`error: ${err.message} in local server.`);
        if (req.client != 'ready') {
          respond({s: false, v: {code: err.code, message: err.message}});
        } else {
          const responseContentPath = req.responseFilePath.split('.')[0];
          writeResponseContent(responseContentPath, JSON.stringify({code: err.code, message: err.message}));
          writeResponseToFile(req.responseFilePath, JSON.stringify({s: false, v: responseContentPath}));
        }
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

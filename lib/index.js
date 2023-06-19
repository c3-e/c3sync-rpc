'use strict';

const path = require('path');
const spawn = require('child_process').spawn;
const spawnSync = require('child_process').spawnSync;
const execSync = require('child_process').execSync;
const JSON = require('./json-buffer');
const isElectron = require('is-electron');
const fs = require('fs');
const os = require('os');
const index = [0];
const timeStamp = new Date().toISOString();
const net = require('net');
let clientConnected = false;
let client;
const READFILETIMELIMIT = 5000;
const debugMode = false;

const responseFolder = path.join(os.tmpdir(), 'sync_rpc_responses');
if (!fs.existsSync(responseFolder)) {
  fs.mkdirSync(responseFolder, {recursive: true});
}

const responseFile = path.join(responseFolder, `responseFile.txt`);

function timeLimitExceeded(startTime) {
  return startTime + READFILETIMELIMIT < Date.now();
}

function responseFileReadOnly() {
  const mode = fs.statSync(responseFile).mode;
  return (mode & parseInt('777', 8)).toString(8) == '444';
}

function responseFileReadyForReading() {
  return fs.existsSync(responseFile) && responseFileReadOnly();
}

function readResponseFile() {
  const startTime = Date.now();
  while (!responseFileReadyForReading()) {
    // if (timeLimitExceeded(startTime)) {
    //   return '';
    // }
  }
  const res = fs.readFileSync(responseFile);
  fs.unlinkSync(responseFile);
  return res;
}

const outFolder = path.join(os.tmpdir(), 'sync_rpc_log');
if (debugMode && !fs.existsSync(outFolder)) {
  fs.mkdirSync(outFolder, {recursive: true});
}

const localClientLog = path.join(outFolder, `client_logs_${timeStamp}.txt`);
const localServerLog = path.join(outFolder, `server_logs_${timeStamp}.txt`);
const localServerErr = path.join(outFolder, `server_error_${timeStamp}.txt`);
function logToFile(msg, logPath) {
  const logMessage = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logPath, logMessage);
}

const outputFile = debugMode && fs.openSync(localServerLog, 'a');
const errorFile = debugMode && fs.openSync(localServerErr, 'a');
const host = '127.0.0.1';
function nodeNetCatSrc(port, input) {
  return (
    "var c=require('net').connect(" +
    port +
    ",'127.0.0.1',()=>{c.pipe(process.stdout);c.end(" +
    JSON.stringify(input)
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029') +
    ')})'
  );
}

const FUNCTION_PRIORITY = [nativeNC, nodeNC];
const FLAGS = isElectron() ? ['--ms-enable-electron-run-as-node'] : [];

let started = false;
const configuration = {port: null, fastestFunction: null};
function start() {
  if (!spawnSync) {
    throw new Error(
      'Sync-request requires node version 0.12 or later.  If you need to use it with an older version of node\n' +
        'you can `npm install sync-request@2.2.0`, which was the last version to support older versions of node.'
    );
  }
  const port = findPort();
  const p = spawn(process.execPath, [require.resolve('./worker'), port, ...FLAGS], {
    stdio: debugMode ? ['ignore', outputFile, errorFile] : 'inherit',
    windowsHide: true,
  });
  p.unref();
  process.on('exit', () => {
    p.kill();
  });
  client = net.connect(port, '127.0.0.1', () => {
    // fs.appendFileSync(path.join(responseFolder, 'clientConnection.txt'), 'connected');
    console.log('client connected.');
    clientConnected = true;
  });
  waitForAlive(port, 1);
  const fastestFunction = getFastestFunction(port);
  configuration.port = port;
  configuration.fastestFunction = fastestFunction;
  started = true;
}

function findPort() {
  const findPortResult = spawnSync(
    process.execPath,
    [require.resolve('./find-port'), ...FLAGS],
    {
      windowsHide: true,
    }
  );
  if (findPortResult.error) {
    if (typeof findPortResult.error === 'string') {
      throw new Error(findPortResult.error);
    }
    throw findPortResult.error;
  }
  if (findPortResult.status !== 0) {
    throw new Error(
      findPortResult.stderr.toString() ||
        'find port exited with code ' + findPortResult.status
    );
  }
  const portString = findPortResult.stdout.toString('utf8').trim();
  if (!/^[0-9]+$/.test(portString)) {
    throw new Error('Invalid port number string returned: ' + portString);
  }
  return +portString;
}

function waitForAlive(port, delay) {
  let response = null;
  let err = null;
  const start = Date.now() + delay * 1000;
  const timeout = start + 10000;
  while (response !== 'pong' && Date.now() < timeout) {
    if (Date.now() > start) {
      const result = nodeNC(port, 'ping\r\n');
      response = result.stdout && result.stdout.toString();
    }
  }
  if (response !== 'pong') {
    throw new Error(
      'Timed out waiting for sync-rpc server to start (it should respond with "pong" when sent "ping"):\n\n' +
        '\n' +
        response
    );
  }
}

function nativeNC(port, input) {
  index[0] = index[0] + 1;
  const channel = 'nativeNC';
  debugMode && logToFile(`${channel} received msg #${index[0]} at client: ${input}`, localClientLog);
  let res;
  try {
    res = spawnSync(`nc`, [host, port], {
        input: input,
        maxBuffer: Infinity,
        windowsHide: true,
      });
  } catch (e) {
    debugMode && logToFile(`Received error: ${e.message}`);
  }
  debugMode && logToFile(`${channel} received response #${index[0]} at client. stderr: ${res.stderr}, status: ${res.status}, signal: ${res.signal}, error: ${res.error}`, localClientLog);
  return res;
}

function nodeNC(port, input) {
  index[0] = index[0] + 1;
  const channel = 'nodeNC';
  const src = nodeNetCatSrc(port, input);
  if (src.length < 1000) {
    debugMode && logToFile(`${channel} received msg #${index[0]} at client: ${input}`, localClientLog);
    const res = spawnSync(process.execPath, ['-e', src, ...FLAGS], {
      windowsHide: true,
      maxBuffer: Infinity,
    });
    debugMode && logToFile(`${channel} received response #${index[0]} at client.`, localClientLog);
    return res;
  } else {
    debugMode && logToFile(`${channel} received msg #${index[0]} at client: ${input}`, localClientLog);
    const res = spawnSync(process.execPath, [...FLAGS], {
      input: src,
      windowsHide: true,
      maxBuffer: Infinity,
    });
    debugMode && logToFile(`${channel} received response #${index[0]} at client.`, localClientLog);
    return res;
  }
}

function test(fn, port) {
  const result = fn(port, 'ping\r\n');
  const response = result.stdout && result.stdout.toString();
  return response === 'pong';
}

function getFastestFunction(port) {
  for (let i = 0; i < FUNCTION_PRIORITY.length; i++) {
    if (test(FUNCTION_PRIORITY[i], port)) {
      return FUNCTION_PRIORITY[i];
    }
  }
}

function sendMessage(input) {
  if (!started) start();
  if (debugMode) {
    const delay = 25; // delay for sending each request in ms
    const startTime = Date.now();
    while (Date.now() < startTime + delay) {
    }
  }
  let res;
  let spawnSyncCall = false;
  if (!clientConnected || input.t === 1) {
    spawnSyncCall = true;
    res = configuration.fastestFunction(
      configuration.port,
      JSON.stringify(input) + '\r\n'
    );
  } else {
    input.client = 'ready';
    index[0] = index[0] + 1;
    const channel = 'keepalive channel';
    const request = JSON.stringify(input).replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029') + '\r\n';
    debugMode && logToFile(`${channel} received msg #${index[0]} at client: ${request}`, localClientLog);
    client.write(request);
    res = readResponseFile();
    debugMode && logToFile(`${channel} received response #${index[0]} at client.`, localClientLog);
  }
  try {
    return JSON.parse(spawnSyncCall ? res.stdout.toString('utf8') : res.toString('utf8'));
  } catch (ex) {
    if (spawnSyncCall) {
      if (res.error) {
        if (typeof res.error === 'string') res.error = new Error(res.error);
        throw res.error;
      }
      if (res.status !== 0) {
        throw new Error(
          configuration.fastestFunction.name +
          ' failed:\n' +
          (res.stdout && res.stdout.toString()) +
          '\n' +
          (res.stderr && res.stderr.toString())
        );
      }
      throw new Error(
        configuration.fastestFunction.name +
        ' failed:\n' +
        (res.stdout && res.stdout).toString() +
        '\n' +
        (res.stderr && res.stderr).toString()
      );
    } else {
      throw new Error(
        'keep-alive channel call failed:\n' +
        (res && res.toString())
      );
    }
  }
}
function extractValue(msg) {
  if (!msg.s) {
    const error = new Error(msg.v.message);
    error.code = msg.v.code;
    throw error;
  }
  return msg.v;
}
function createClient(filename, args) {
  const id = extractValue(sendMessage({t: 1, f: filename, a: args}));
  return function(args) {
    return extractValue(sendMessage({t: 0, i: id, a: args}));
  };
}
createClient.FUNCTION_PRIORITY = FUNCTION_PRIORITY;
createClient.configuration = configuration;

module.exports = createClient;

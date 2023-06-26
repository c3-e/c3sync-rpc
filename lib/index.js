'use strict';

const path = require('path');
const spawn = require('child_process').spawn;
const spawnSync = require('child_process').spawnSync;
const JSON = require('./json-buffer');
const isElectron = require('is-electron');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const index = [0];
const timeStamp = new Date().toISOString();
const net = require('net');
// to hold the keep-alive connection to worker thread.
let client;
// set to true after keep-alive connection is successfully created.
let clientConnected = false;
const READFILETIMELIMIT = 30000;
const debugMode = false;

/**
 * Update:
 *    1. Instead of constantly relying on spawnSync for handling every msg, create a keep-alive connection that can be
 *       used to send msg to worker thread.
 *    2. For sending response back from worker thread, worker thread confirms the response file doesn't exist, and then
 *       create the file and writes the response. Upon finishing writing, change the file permission to read-only.
 *    3. For loading the response from main thread, check the existance of the response file and confirm the permission
 *       is read-only, then read the file and delete it.
 *    Step 2 & 3 serve as file locking mechanism so that the 2 processes can communicate through it.
 */

const responseFolder = path.join(os.tmpdir(), 'sync_rpc_responses');
if (!fs.existsSync(responseFolder)) {
  fs.mkdirSync(responseFolder, {recursive: true});
}

function responseFilePath() {
  return path.join(responseFolder, `responseFile_${crypto.randomInt(0, 1000000).toString().padStart(6, '0')}.txt`);
}

function timeLimitExceeded(startTime) {
  return startTime + READFILETIMELIMIT < Date.now();
}

function responseFileReadOnly(filePath) {
  const mode = fs.statSync(filePath).mode;
  return (mode & parseInt('777', 8)).toString(8) == '444';
}

/**
 * @returns {boolean} True if the file is existing and permission is read only.
 */
function responseFileReadyForReading(filePath) {
  return fs.existsSync(filePath) && responseFileReadOnly(filePath);
}

/**
 * Read the response file for the response content that is written by worker thread.
 * @returns {Buffer}
 */
function readResponseFile(filePath) {
  const startTime = Date.now();
  while (!responseFileReadyForReading(filePath)) {
    if (timeLimitExceeded(startTime)) {
      throw new Error("Response file waiting to read for > 30s in main thread in sync-rpc.");
    }
  }
  const contentPath = filePath.split(".")[0];
  const content = fs.readFileSync(contentPath);
  const res = JSON.parse(fs.readFileSync(filePath));
  if (res.s == true) {
    res.v.b = content.toString('utf-8');
  } else {
    res.v = JSON.parse(content.toString('utf-8'));
  }
  fs.unlinkSync(contentPath);
  fs.unlinkSync(filePath);
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
  // '--inspect-brk',
  const p = spawn(process.execPath, [require.resolve('./worker'), port, ...FLAGS], {
    stdio: debugMode ? ['ignore', outputFile, errorFile] : 'inherit',
    windowsHide: true,
  });
  p.unref();
  process.on('exit', () => {
    p.kill();
  });
  client = net.connect(port, '127.0.0.1', () => {
    debugMode && console.log('client connected.');
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
  let res;
  let spawnSyncCall = false;
  // when keep-alive connection is not created, or the input type is to setup the request handler in worker thread (input.t === 1), rely on the original logic for handling request.
  if (!clientConnected || input.t === 1) {
    spawnSyncCall = true;
    res = configuration.fastestFunction(
      configuration.port,
      JSON.stringify(input) + '\r\n'
    );
  } else {
    // when keep-alive connection is ready, rely on that for handling normal requests.
    input.client = 'ready';
    input.responseFilePath = responseFilePath();
    index[0] = index[0] + 1;
    const channel = 'keepalive channel';
    const request = JSON.stringify(input).replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029') + '\r\n';
    debugMode && logToFile(`${channel} received msg #${index[0]} at client: ${request}`, localClientLog);
    client.write(request);
    res = readResponseFile(input.responseFilePath);
    debugMode && logToFile(`${channel} received response #${index[0]} at client.`, localClientLog);
  }
  try {
    return spawnSyncCall ? JSON.parse(res.stdout.toString('utf8')) : res;
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

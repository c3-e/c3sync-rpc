// Preloaded via NODE_OPTIONS so every port probe returns the same port.
const Module = require('module');
const load = Module._load;
Module._load = function(request, ...rest) {
  if (request === 'get-port') return () => Promise.resolve(+process.env.SYNC_RPC_TEST_FIXED_PORT);
  return load.call(this, request, ...rest);
};

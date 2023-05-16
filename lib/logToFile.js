const fs = require('fs');
const path = require('path');

export function logToFile(msg, logPath) {
  const logMessage = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logPath, logMessage);
}

process.on('uncaughtException', (error) => {
  logToFile(`Uncaught exception: ${error.stack}`);
  process.exit(1);
});

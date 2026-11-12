const { mkdirSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const destination = join(__dirname, 'runtime');
mkdirSync(destination, { recursive: true });
copyFileSync(process.execPath, join(destination, 'node.exe'));

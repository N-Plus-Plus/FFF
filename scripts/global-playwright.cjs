const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { join } = require('node:path');

const windows = process.platform === 'win32';
const command = windows ? process.env.ComSpec || 'cmd.exe' : 'npm';
const args = windows ? ['/d', '/c', 'npm.cmd', 'root', '-g'] : ['root', '-g'];
const globalRoot = process.env.PLAYWRIGHT_GLOBAL_ROOT || execFileSync(command, args, {
  encoding: 'utf8', windowsHide: true,
}).trim();

let playwright;
try {
  playwright = createRequire(join(globalRoot, '.playwright-resolver.cjs'))('playwright');
} catch (error) {
  throw new Error('Install Playwright globally with npm and run playwright install chromium.', { cause: error });
}

exports.chromium = playwright.chromium;

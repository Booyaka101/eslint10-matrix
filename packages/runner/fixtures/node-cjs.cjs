'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'fixture-app');

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  return CACHE_DIR;
}

function readManifest(dir) {
  const file = path.join(dir, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function gitHead(cwd, callback) {
  execFile('git', ['rev-parse', 'HEAD'], { cwd }, (err, stdout) => {
    if (err) {
      callback(err);
      return;
    }
    callback(null, stdout.trim());
  });
}

function walk(dir, seen) {
  const visited = seen || new Set();
  const real = fs.realpathSync(dir);
  if (visited.has(real)) {
    return [];
  }
  visited.add(real);

  const out = [];
  for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(real, entry.name);
    if (entry.isDirectory()) {
      out.push.apply(out, walk(full, visited));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

module.exports = { ensureCacheDir, readManifest, gitHead, walk, CACHE_DIR };

#!/usr/bin/env node
'use strict';
const { execSync } = require('child_process');
const { join } = require('path');

const root = join(__dirname, '..');
execSync(
  `npx esbuild scripts/codemirror-entry.js --bundle --format=iife --global-name=CM --outfile=public/lib/codemirror/codemirror-bundle.js --minify`,
  { cwd: root, stdio: 'inherit' }
);
console.log('CodeMirror bundle built.');

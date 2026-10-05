#!/usr/bin/env node
// Plain-JS entry point, so an unsupported Node version fails with a readable message instead of a
// syntax error from the TypeScript sources.
//
// Which entry runs is decided by what is on disk:
//   - sources win when they are present, so a checkout can never run a stale build. A checkout
//     needs no build step: Node strips the types itself.
//   - the published package ships only dist/ (Node refuses to strip types for files under
//     node_modules: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so an install runs the bundle.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
const MIN_MAJOR = 22, MIN_MINOR = 6;

if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
  process.stderr.write(
    `[jira-server] Node >= ${MIN_MAJOR}.${MIN_MINOR} is required, but this is ${process.version}.\n` +
    `The published bundle is plain JS; a source checkout runs TypeScript directly and needs the newer Node.\n`,
  );
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src/index.ts');
const bundled = resolve(root, 'dist/jira-server.mjs');
const entry = existsSync(source) ? source : bundled;

if (!existsSync(entry)) {
  process.stderr.write(
    `[jira-server] found neither ${source} nor ${bundled}. ` +
    `Run from a source checkout, or install the published package.\n`,
  );
  process.exit(1);
}

// A `file://` URL, not a path: on Windows `C:\...` reads as a URL scheme and Node refuses it
// (ERR_UNSUPPORTED_ESM_URL_SCHEME), while a POSIX path happens to work.
await import(pathToFileURL(entry).href);

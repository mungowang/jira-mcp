#!/usr/bin/env node
// Plain-JS entry point, so an unsupported Node version fails with a readable message instead of a
// syntax error from the TypeScript sources.
//
// Two ways in, decided by what is on disk:
//   - a published install runs the bundled dist/jira-server.mjs. It has to: Node refuses to strip
//     types for files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the
//     sources cannot run from an installed package.
//   - a source checkout has no dist/ and runs src/index.ts directly, with no build step.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const bundled = resolve(root, 'dist/jira-server.mjs');
await import(existsSync(bundled) ? bundled : resolve(root, 'src/index.ts'));

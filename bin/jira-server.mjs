#!/usr/bin/env node
// Plain-JS entry point so an unsupported Node version fails with a readable message
// instead of a syntax error from the TypeScript sources.
const [major, minor] = process.versions.node.split('.').map(Number);
const MIN_MAJOR = 22, MIN_MINOR = 6;

if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
  process.stderr.write(
    `[jira-server] Node >= ${MIN_MAJOR}.${MIN_MINOR} is required (native TypeScript type stripping), ` +
    `but this is ${process.version}. No build step is needed - just upgrade Node.\n`,
  );
  process.exit(1);
}

await import('../src/index.ts');

#!/usr/bin/env node

const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  process.stderr.write(`agent-fleet needs Node.js 20 or later; this is ${process.version}.\n`);
  process.exit(1);
}

const { main } = await import("../lib/cli.mjs");
process.exitCode = await main(process.argv.slice(2));

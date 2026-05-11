#!/usr/bin/env node
import { runDispatch } from "./cli.js";

runDispatch(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`Unhandled dispatch error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  }
);

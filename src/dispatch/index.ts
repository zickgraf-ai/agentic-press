#!/usr/bin/env node
import { runDispatch, EXIT_CODES } from "./cli.js";

const SIGNAL_EXIT_CODE = 130;
const FORCE_KILL_DELAY_MS = 5_000;

const controller = new AbortController();
let signalReceived = false;

function onSignal(sig: NodeJS.Signals): void {
  if (signalReceived) {
    process.stderr.write(`\nReceived ${sig} again — forcing exit.\n`);
    process.exit(SIGNAL_EXIT_CODE);
  }
  signalReceived = true;
  process.stderr.write(`\nReceived ${sig} — cleaning up. Press Ctrl-C again to force.\n`);
  controller.abort();
  // Hard-kill backstop: if cleanup hangs past FORCE_KILL_DELAY_MS, force exit.
  // .unref() so a normal clean cleanup isn't blocked by this timer.
  setTimeout(() => {
    process.stderr.write(`\nCleanup exceeded ${FORCE_KILL_DELAY_MS}ms — forcing exit.\n`);
    process.exit(SIGNAL_EXIT_CODE);
  }, FORCE_KILL_DELAY_MS).unref();
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

runDispatch(process.argv.slice(2), controller.signal).then(
  (code) => process.exit(signalReceived ? SIGNAL_EXIT_CODE : code),
  (err) => {
    process.stderr.write(
      `Internal dispatch error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`
    );
    process.exit(EXIT_CODES.INTERNAL_ERROR);
  }
);

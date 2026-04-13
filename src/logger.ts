import pino, { type Logger, type DestinationStream } from "pino";
import { parseLogLevel } from "./types.js";

/**
 * Create a structured pino logger. Exported for tests that need a fresh
 * instance with a custom destination; production code uses the module
 * singleton (default export).
 */
export function createLogger(
  level?: string,
  destination?: DestinationStream
): Logger {
  const resolved = parseLogLevel(level);
  return destination
    ? pino({ level: resolved }, destination)
    : pino({ level: resolved });
}

/**
 * Create a child logger scoped to a module. Each source module calls this
 * once at the top level to attach its own `module` context field.
 */
export function childLogger(module: string): Logger {
  return logger.child({ module });
}

// Module singleton — reads LOG_LEVEL from process.env at import time.
const logger = createLogger(process.env.LOG_LEVEL);
export default logger;

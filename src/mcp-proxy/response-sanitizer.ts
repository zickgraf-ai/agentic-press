import { sanitize, type SanitizeFlag } from "./sanitizer.js";

export interface ResponseSanitizeResult {
  readonly flags: readonly SanitizeFlag[];
}

// Defense-in-depth caps against pathological upstream responses. A hostile
// MCP server could return a cyclic object (→ infinite loop) or a 10k-deep
// nest (→ RangeError). Both would bypass the sanitizer and fail the request
// into the generic request-path catch. Cap depth, track visited objects.
const MAX_DEPTH = 64;
// Limit duplicate flags so one nasty repeated payload cannot bloat the
// audit log to unbounded size.
const MAX_FLAGS = 64;

// Fields known to carry binary/non-prompt payloads in MCP content blocks.
// We skip these specific keys inside image/audio blocks only — sibling
// text-ish fields (alt text, captions, text injected adversarially) are
// still walked, because `type` is attacker-controlled and a hostile server
// can mark any block as "image" to smuggle prompt content past a whole-block
// skip.
const BINARY_FIELDS: ReadonlySet<string> = new Set(["data", "blob"]);

function collectStringsSkippingBinary(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  out: string[]
): void {
  if (depth > MAX_DEPTH) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;

  // Reject exotic objects whose fields are opaque or unsafe to walk.
  // Date/Buffer/TypedArray stringify to fixed shapes that cannot carry
  // injection prompts; treat them as scalars and skip.
  if (value instanceof Date) return;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return;
  if (ArrayBuffer.isView(value)) return;

  if (seen.has(value as object)) return;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringsSkippingBinary(item, seen, depth + 1, out);
    }
    return;
  }

  const obj = value as Record<string, unknown>;
  const isBinaryBlock = obj.type === "image" || obj.type === "audio";
  for (const [key, v] of Object.entries(obj)) {
    if (isBinaryBlock && BINARY_FIELDS.has(key)) continue;
    collectStringsSkippingBinary(v, seen, depth + 1, out);
  }
}

function dedupe(flags: readonly SanitizeFlag[]): SanitizeFlag[] {
  const seen = new Set<string>();
  const unique: SanitizeFlag[] = [];
  for (const f of flags) {
    const key = `${f.pattern}:${f.position}:${f.match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
    if (unique.length >= MAX_FLAGS) break;
  }
  return unique;
}

export function sanitizeResponse(result: unknown): ResponseSanitizeResult {
  const strings: string[] = [];
  collectStringsSkippingBinary(result, new WeakSet<object>(), 0, strings);
  const flags: SanitizeFlag[] = [];
  for (const str of strings) {
    const r = sanitize(str);
    if (r.flags.length > 0) flags.push(...r.flags);
    if (flags.length >= MAX_FLAGS * 4) break;
  }
  return { flags: dedupe(flags) };
}

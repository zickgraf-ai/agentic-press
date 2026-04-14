import { sanitize, type SanitizeFlag } from "./sanitizer.js";

export interface ResponseSanitizeResult {
  readonly flags: readonly SanitizeFlag[];
}

// Walk string-valued fields in an MCP tool-call result and flag any that
// match an injection pattern. Binary/image/audio content blocks are skipped
// — their `data` field is a base64 blob, not a string the agent will interpret.
function collectStringsSkippingBinary(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringsSkippingBinary);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const type = obj.type;
    if (type === "image" || type === "audio") return [];
    return Object.values(obj).flatMap(collectStringsSkippingBinary);
  }
  return [];
}

export function sanitizeResponse(result: unknown): ResponseSanitizeResult {
  const flags: SanitizeFlag[] = [];
  for (const str of collectStringsSkippingBinary(result)) {
    const r = sanitize(str);
    if (r.flags.length > 0) flags.push(...r.flags);
  }
  return { flags };
}

import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { validateSessionInput } from "../orchestrator/session-registry.js";

const SANDBOX_NAME_PATTERN = /^[a-z0-9-]{1,40}$/;

export interface AgentManifestEntry {
  readonly agentType: string;
  readonly allowedTools: readonly string[];
  readonly agentCommand: readonly string[];
  readonly workspace: string;
  readonly sandboxName?: string;
  readonly extraSbxArgs?: readonly string[];
}

export interface AgentManifest {
  readonly agents: readonly AgentManifestEntry[];
}

// Share the control-plane's validator so a parsed manifest cannot 400 at
// register time. The sessionId is known only at mint time, so we pass a fixed
// well-formed placeholder and rely on validateSessionInput's order to short-
// circuit on the agentType + allowedTools branches we actually care about.
// If validateSessionInput is ever reordered to check sessionId last or to
// add cross-field rules, this fixture goes stale silently — guard with the
// "shared-contract" tests in tests/orchestrator/session-id.test.ts.
const PLACEHOLDER_SESSION_ID = "placeholder";
function validateAgentTypeAndAllowedTools(
  agentType: unknown,
  allowedTools: unknown
): { ok: true } | { ok: false; error: string } {
  return validateSessionInput({
    sessionId: PLACEHOLDER_SESSION_ID,
    agentType,
    allowedTools,
  });
}

export function parseManifestFile(path: string): AgentManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read manifest file at "${path}": ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse manifest JSON at "${path}": ${msg}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Manifest must be a JSON object with an "agents" array, got ${
        Array.isArray(parsed) ? "array" : typeof parsed
      }. Example: { "agents": [ { ... } ] }`
    );
  }
  const root = parsed as Record<string, unknown>;
  if (!("agents" in root) || !Array.isArray(root.agents)) {
    throw new Error('Manifest missing required "agents" array');
  }
  if (root.agents.length === 0) {
    throw new Error('Manifest must contain at least one agent in "agents"');
  }
  const agents: AgentManifestEntry[] = [];
  for (let i = 0; i < root.agents.length; i++) {
    agents.push(validateAgentEntry(root.agents[i], i));
  }
  return { agents };
}

export function validateWorkspace(path: unknown, where: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`${where} must be a non-empty string`);
  }
  if (!isAbsolute(path)) {
    throw new Error(`${where} must be an absolute path, got "${path}"`);
  }
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      throw new Error(`${where} does not exist: "${path}"`);
    }
    throw new Error(`${where} cannot be accessed (${code ?? "unknown"}): "${path}"`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${where} must be a directory, "${path}" is not`);
  }
  return path;
}

export function validateAgentEntry(raw: unknown, index: number): AgentManifestEntry {
  const where = `agents[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object, got ${Array.isArray(raw) ? "array" : typeof raw}`);
  }
  const entry = raw as Record<string, unknown>;

  const sharedCheck = validateAgentTypeAndAllowedTools(entry.agentType, entry.allowedTools);
  if (!sharedCheck.ok) {
    throw new Error(`${where}: ${sharedCheck.error}`);
  }
  const agentType = entry.agentType as string;
  const allowedTools = (entry.allowedTools as unknown[]).map((t) => t as string);

  if (!Array.isArray(entry.agentCommand)) {
    throw new Error(`${where}.agentCommand must be a non-empty array of strings`);
  }
  if (entry.agentCommand.length === 0) {
    throw new Error(`${where}.agentCommand must be a non-empty array of strings`);
  }
  for (let j = 0; j < entry.agentCommand.length; j++) {
    const part = entry.agentCommand[j];
    if (typeof part !== "string" || part.length === 0) {
      throw new Error(
        `${where}.agentCommand[${j}] must be a non-empty string, got ${JSON.stringify(part)}`
      );
    }
  }
  const agentCommand = entry.agentCommand.map((s) => s as string);

  const workspace = validateWorkspace(entry.workspace, `${where}.workspace`);

  let sandboxName: string | undefined;
  if (entry.sandboxName !== undefined) {
    if (typeof entry.sandboxName !== "string" || !SANDBOX_NAME_PATTERN.test(entry.sandboxName)) {
      throw new Error(
        `${where}.sandboxName must match [a-z0-9-]{1,40}, got ${JSON.stringify(entry.sandboxName)}`
      );
    }
    sandboxName = entry.sandboxName;
  }

  let extraSbxArgs: string[] | undefined;
  if (entry.extraSbxArgs !== undefined) {
    if (!Array.isArray(entry.extraSbxArgs)) {
      throw new Error(`${where}.extraSbxArgs must be an array of strings`);
    }
    for (let j = 0; j < entry.extraSbxArgs.length; j++) {
      const part = entry.extraSbxArgs[j];
      if (typeof part !== "string" || part.length === 0) {
        throw new Error(
          `${where}.extraSbxArgs[${j}] must be a non-empty string, got ${JSON.stringify(part)}`
        );
      }
    }
    extraSbxArgs = entry.extraSbxArgs.map((s) => s as string);
  }

  return {
    agentType,
    allowedTools,
    agentCommand,
    workspace,
    ...(sandboxName !== undefined ? { sandboxName } : {}),
    ...(extraSbxArgs !== undefined ? { extraSbxArgs } : {}),
  };
}

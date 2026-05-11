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

export function validateAgentEntry(raw: unknown, index: number): AgentManifestEntry {
  const where = `agents[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be an object, got ${Array.isArray(raw) ? "array" : typeof raw}`);
  }
  const entry = raw as Record<string, unknown>;

  // Re-use the control-plane's validation contract for agentType + allowedTools
  // so a manifest that parses always produces a payload that won't 400.
  // sessionId is a stand-in here — the registry contract validates it the same
  // way as agentType, and we don't know the real sessionId until mint time.
  const sharedCheck = validateSessionInput({
    sessionId: "placeholder",
    agentType: entry.agentType,
    allowedTools: entry.allowedTools,
  });
  if (!sharedCheck.ok) {
    throw new Error(`${where}: ${sharedCheck.error}`);
  }
  const agentType = entry.agentType as string;
  const allowedTools = (entry.allowedTools as unknown[]).map((t) => t as string);

  // agentCommand
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

  // workspace
  if (typeof entry.workspace !== "string" || entry.workspace.length === 0) {
    throw new Error(`${where}.workspace must be a non-empty string`);
  }
  if (!isAbsolute(entry.workspace)) {
    throw new Error(`${where}.workspace must be an absolute path, got "${entry.workspace}"`);
  }
  let stat;
  try {
    stat = statSync(entry.workspace);
  } catch {
    throw new Error(`${where}.workspace does not exist: "${entry.workspace}"`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${where}.workspace must be a directory, "${entry.workspace}" is not`);
  }
  const workspace = entry.workspace;

  // sandboxName (optional)
  let sandboxName: string | undefined;
  if (entry.sandboxName !== undefined) {
    if (typeof entry.sandboxName !== "string" || !SANDBOX_NAME_PATTERN.test(entry.sandboxName)) {
      throw new Error(
        `${where}.sandboxName must match [a-z0-9-]{1,40}, got ${JSON.stringify(entry.sandboxName)}`
      );
    }
    sandboxName = entry.sandboxName;
  }

  // extraSbxArgs (optional)
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

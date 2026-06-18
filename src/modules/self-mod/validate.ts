/**
 * Shared validators for agent self-modification payloads.
 *
 * These names/commands are carried verbatim on a pending_approvals row and,
 * on approve, flow into shell exec (apt/npm install) or an MCP server spawn.
 * Both the request side (reject early, tell the agent) and the apply side
 * (defense-in-depth — never trust the stored payload) validate with the same
 * rules, so they live here instead of being duplicated.
 */

/** Debian package name. */
export const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
/** npm package name, optionally scoped. */
export const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** MCP server identifier (used as a JSON object key + shown to the user). */
export const MCP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** MCP command — a single executable (name or path), no shell metacharacters. */
export const MCP_COMMAND_RE = /^[a-zA-Z0-9._/-]+$/;

export const MAX_PACKAGES = 20;

export interface ValidationResult {
  ok: boolean;
  /** Human-readable reason, suitable to surface to the agent. Set when !ok. */
  error?: string;
}

/** Validate an install_packages payload (count + per-name regex). */
export function validatePackages(apt: string[], npm: string[]): ValidationResult {
  if (apt.length + npm.length === 0) {
    return { ok: false, error: 'at least one apt or npm package is required.' };
  }
  if (apt.length + npm.length > MAX_PACKAGES) {
    return { ok: false, error: `max ${MAX_PACKAGES} packages per request.` };
  }
  const badApt = apt.find((p) => !APT_RE.test(p));
  if (badApt) return { ok: false, error: `invalid apt package name "${badApt}".` };
  const badNpm = npm.find((p) => !NPM_RE.test(p));
  if (badNpm) return { ok: false, error: `invalid npm package name "${badNpm}".` };
  return { ok: true };
}

/** Validate an add_mcp_server payload (name, command, args shape). */
export function validateMcpServer(name: unknown, command: unknown, args: unknown): ValidationResult {
  if (typeof name !== 'string' || typeof command !== 'string' || !name || !command) {
    return { ok: false, error: 'name and command are required.' };
  }
  if (!MCP_NAME_RE.test(name)) {
    return { ok: false, error: `invalid MCP server name "${name}".` };
  }
  if (!MCP_COMMAND_RE.test(command)) {
    return { ok: false, error: `invalid MCP command "${command}" (no spaces or shell metacharacters).` };
  }
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
    return { ok: false, error: 'MCP args must be an array of strings.' };
  }
  return { ok: true };
}

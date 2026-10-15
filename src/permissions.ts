// Project permissions file: .mailbox-mcp/permissions.json at the project root.
//
// Finds the file, reads it safely (it can come from any repo) and fails closed
// in a way the model can see: a bad file gives a server with no tools whose
// instructions say why. What the keys mean belongs to later plans; each adds
// its key to `known` in the same change that enforces it, so a key this build
// doesn't know is an error rather than a silently ignored restriction.
//
// Nothing from the file, and no exception text, ever reaches a message: every
// failure has fixed words, and keys are only counted, never named.

import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export type ProjectRules = { displayPath: string; root: string; keys: Record<string, unknown> };

export type PermissionsState =
  | { kind: "none" }
  | { kind: "rules"; project: ProjectRules; warnings: string[] }
  | { kind: "error"; message: string };

export const MAX_PERMISSIONS_BYTES = 65_536;

export class PermissionsFileError extends Error {
  constructor(readonly kind: string, readonly code?: string) {
    super(kind);
    this.name = "PermissionsFileError";
  }
}

export interface LoadInput {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  known: readonly string[];
  read?: (path: string) => string;
}

/** The nearest folder at or above `start` that holds a `.git` entry (folder or file); else `start`. */
export function findProjectRoot(start: string, exists: (p: string) => boolean): string {
  let dir = start;
  for (;;) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Same rule as pending.ts and save-path.ts: set and not empty, else ~/.mailbox-mcp. */
export function resolveConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.MAILBOX_MCP_CONFIG_DIR || join(home, ".mailbox-mcp");
}

function kindForCode(code: string | undefined): string {
  switch (code) {
    case "ELOOP": return "is a symbolic link";
    case "ENOTDIR": return "`.mailbox-mcp` is not a folder";
    case "EISDIR": return "is a folder";
    case "EACCES":
    case "EPERM": return "can't be read";
    default: return "could not be read";
  }
}

/**
 * Reads a file that may come from an untrusted repo: no symlink, a regular file
 * owned by the current user, at most MAX_PERMISSIONS_BYTES, leading BOM removed.
 * Throws PermissionsFileError with fixed words; `code` is "ENOENT" for a missing file.
 */
export function readSafeFile(path: string): string {
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined) throw new PermissionsFileError("can't be checked for symbolic links on this platform");
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new PermissionsFileError(code === "ENOENT" ? "does not exist" : kindForCode(code), code);
  }
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) throw new PermissionsFileError("is a folder");
    if (!st.isFile()) throw new PermissionsFileError("is not a regular file");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new PermissionsFileError("is not owned by you");
    }
    // Read one byte past the cap from the open file, whatever fstat said: the
    // file can grow between the two.
    const buf = Buffer.alloc(MAX_PERMISSIONS_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > MAX_PERMISSIONS_BYTES) throw new PermissionsFileError("is too big (over 64 KB)");
    const text = buf.subarray(0, total).toString("utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } finally {
    closeSync(fd);
  }
}

function sameFolder(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function stripControl(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, "");
}

export function loadProjectPermissions(input: LoadInput): PermissionsState {
  const fromEnv = !!input.env.CLAUDE_PROJECT_DIR;
  const start = input.env.CLAUDE_PROJECT_DIR || input.cwd;
  const root = findProjectRoot(start, existsSync);
  const folder = join(root, ".mailbox-mcp");
  const up = relative(start, root);
  const displayPath = stripControl(
    `${fromEnv ? "$CLAUDE_PROJECT_DIR" : "<cwd>"}/${up ? `${up}/` : ""}.mailbox-mcp/permissions.json`,
  );
  const fail = (words: string): PermissionsState => ({ kind: "error", message: `${displayPath} ${words}` });

  // A session started in ~ must not read the user's own config folder as a project's rules.
  if (sameFolder(folder, resolveConfigDir(input.env, input.home))) return { kind: "none" };

  let text: string;
  try {
    text = (input.read ?? readSafeFile)(join(folder, "permissions.json"));
  } catch (err) {
    if (err instanceof PermissionsFileError) return err.code === "ENOENT" ? { kind: "none" } : fail(err.kind);
    return fail("could not be read");
  }

  if (text.trim() === "") return fail("is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail("is not a JSON object");

  const obj = parsed as Record<string, unknown>;
  const unknownCount = Object.keys(obj).filter((k) => !input.known.includes(k)).length;
  if (unknownCount > 0) {
    return fail(`has ${unknownCount} ${unknownCount === 1 ? "key" : "keys"} this version doesn't know (update the fork, or remove them)`);
  }

  const keys: Record<string, unknown> = Object.create(null);
  for (const k of input.known) if (Object.hasOwn(obj, k)) keys[k] = obj[k];
  if (Object.keys(keys).length === 0) return { kind: "none" };
  return { kind: "rules", project: { displayPath, root, keys }, warnings: [] };
}

export function unavailableText(message: string): string {
  return `Mail is unavailable in this project: ${message}. Tell the user. Do not edit or delete that file yourself; the user fixes it, then reconnects the mailbox server (/mcp → mailbox → reconnect) or starts a new session.`;
}

export function buildInstructions(state: PermissionsState, normal: string): string {
  if (state.kind === "error") return unavailableText(state.message);
  if (state.kind === "rules" && state.warnings.length > 0) return `${normal} Tell the user: ${state.warnings.join(" ")}`;
  return normal;
}

let current: PermissionsState = { kind: "none" };

export function setPermissionsState(state: PermissionsState): void {
  current = state;
}

export function getPermissionsState(): PermissionsState {
  return current;
}

export function resetPermissions(): void {
  current = { kind: "none" };
}

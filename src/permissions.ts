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

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

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
    case "ENOTDIR": return "can't be reached (`.mailbox-mcp` is not a folder)";
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
export function readSafeFile(path: string, fsConstants: { O_RDONLY: number; O_NOFOLLOW?: number; O_NONBLOCK?: number } = constants): string {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (noFollow === undefined) {
    // No O_NOFOLLOW (Windows): a missing file is still "no rules"; an existing
    // one is refused, since it can't be opened without following a link.
    try {
      lstatSync(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new PermissionsFileError(code === "ENOENT" ? "does not exist" : kindForCode(code), code);
    }
    throw new PermissionsFileError("can't be checked for symbolic links on this platform");
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | (fsConstants.O_NONBLOCK ?? 0));
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

// lstat, not exists: a .git entry of any type counts, a dangling symlink included.
function hasEntry(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function loadProjectPermissions(input: LoadInput): PermissionsState {
  const fromEnv = !!input.env.CLAUDE_PROJECT_DIR;
  const start = resolve(input.env.CLAUDE_PROJECT_DIR || input.cwd);
  const root = findProjectRoot(start, hasEntry);
  const folder = join(root, ".mailbox-mcp");
  const up = relative(start, root);
  // Built from fixed text and ".." segments only: never an absolute path, never file content.
  const displayPath = `${fromEnv ? "$CLAUDE_PROJECT_DIR" : "<cwd>"}/${up ? `${up}/` : ""}.mailbox-mcp/permissions.json`;
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
  return `Mail is unavailable in this project: ${message} ($CLAUDE_PROJECT_DIR and <cwd> mean the folder this session started in). Tell the user. Do not edit or delete that file unless the user asks you to in their own message; once it is fixed, the user reconnects the mailbox server (/mcp → mailbox → reconnect) or starts a new session.`;
}

export function buildInstructions(state: PermissionsState, normal: string): string {
  if (state.kind === "error") return unavailableText(state.message);
  if (state.kind === "rules" && state.warnings.length > 0) return `${normal} Tell the user: ${state.warnings.join(" ")}`;
  return normal;
}

// Default "none" so CLI mode and tests behave as before. Every entry point that
// serves tools must call initProjectPermissions first, or it runs without the
// project's rules.
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

/**
 * The server's input. cwd is only read when CLAUDE_PROJECT_DIR is unset: it
 * throws when the session's folder was deleted, and an unneeded cwd must not
 * take mail away.
 */
export function startupInput(
  env: NodeJS.ProcessEnv = process.env,
  cwd: () => string = () => process.cwd(),
  home: () => string = homedir,
): Omit<LoadInput, "read"> {
  return { env, cwd: env.CLAUDE_PROJECT_DIR ? "" : cwd(), home: home(), known: [] };
}

/**
 * Load the project's file at server start and install the state. Never throws:
 * anything unexpected, including an error while gathering the input, becomes
 * the error state with fixed words. `log` receives fixed text only. (Warnings
 * stay empty until a later plan adds keys that produce them.)
 */
export function initProjectPermissions(getInput: () => Omit<LoadInput, "read">, log: (kind: string, detail: string) => void): PermissionsState {
  let state: PermissionsState;
  try {
    // getInput runs inside the try: process.cwd() throws when the session's
    // folder was deleted, and that must become the error state, not a crash.
    state = loadProjectPermissions(getInput());
  } catch (err) {
    state = { kind: "error", message: "the project's .mailbox-mcp/permissions.json could not be read" };
    const code = (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? "error";
    setPermissionsState(state);
    console.error(`mailbox-mcp: mail unavailable: ${state.message}`);
    log("permissions-error", `${state.message} (unexpected ${code})`);
    return state;
  }
  setPermissionsState(state);
  if (state.kind === "error") {
    console.error(`mailbox-mcp: mail unavailable: ${state.message}`);
    log("permissions-error", state.message);
  } else if (state.kind === "rules" && state.warnings.length > 0) {
    console.error(`mailbox-mcp: ${state.warnings.join(" ")}`);
    log("permissions-warning", state.warnings.join(" "));
  }
  return state;
}

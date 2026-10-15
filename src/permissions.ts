// STUB (plan 001, phase 1): the API with no behaviour, so the tests can be
// seen failing on their assertions before the real code is written.

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

export function findProjectRoot(_start: string, _exists: (p: string) => boolean): string {
  return "";
}

export function resolveConfigDir(_env: NodeJS.ProcessEnv, _home: string): string {
  return "";
}

export function readSafeFile(_path: string): string {
  return "";
}

export function loadProjectPermissions(_input: LoadInput): PermissionsState {
  return { kind: "none" };
}

export function buildInstructions(_state: PermissionsState, normal: string): string {
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

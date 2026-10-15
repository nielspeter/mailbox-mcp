import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Runs the built server (npm run build first) with a bad project permissions
// file and talks MCP to it over stdio. Every spawn gets its own HOME, project
// and config folders, so nothing real is read or written.

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");
const MARKER = "PLANTED_MARKER_c41e";
const temps: string[] = [];

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "mbx-stdio-"));
  temps.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

type Rpc = { id?: number; result?: any; error?: any };

function startServer(projectDir: string): { p: ChildProcess; stderr: () => string; request: (id: number, method: string, params?: object) => Promise<Rpc>; running: Promise<void> } {
  const home = temp();
  const p = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: projectDir, MAILBOX_MCP_CONFIG_DIR: join(home, ".mailbox-mcp"), MAILBOX_MCP_PROFILE: "" },
  });
  let err = "";
  let out = "";
  const waiting = new Map<number, (r: Rpc) => void>();
  p.stdout!.on("data", (chunk) => {
    out += chunk;
    let nl: number;
    while ((nl = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, nl);
      out = out.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as Rpc;
        if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
      } catch {}
    }
  });
  const running = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start within 4s")), 4000);
    p.stderr!.on("data", (chunk) => {
      err += chunk;
      if (err.includes("server running on stdio")) { clearTimeout(timer); resolve(); }
    });
    p.on("exit", () => { clearTimeout(timer); reject(new Error("server exited")); });
  });
  const request = (id: number, method: string, params: object = {}) =>
    new Promise<Rpc>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 4000);
      waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
      p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { p, stderr: () => err, request, running };
}

describe("server with a bad project permissions file", () => {
  it("stays up, lists no tools, and says why without file content", async () => {
    const project = temp();
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, ".mailbox-mcp"));
    writeFileSync(join(project, ".mailbox-mcp", "permissions.json"), `{"x": ${MARKER}`);

    const s = startServer(project);
    try {
      await s.running;
      const init = await s.request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      });
      const instructions: string = init.result?.instructions ?? "";
      expect(instructions).toContain("Mail is unavailable in this project");
      expect(instructions).toContain("$CLAUDE_PROJECT_DIR/.mailbox-mcp/permissions.json is not valid JSON");
      expect(instructions).not.toContain("UNTRUSTED");
      expect(instructions).not.toContain(MARKER);

      s.p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const list = await s.request(2, "tools/list");
      expect(list.result?.tools).toEqual([]);

      expect(s.stderr()).toContain("mail unavailable");
      expect(s.stderr()).not.toContain(MARKER);
      expect(s.p.exitCode).toBeNull();
    } finally {
      s.p.kill("SIGKILL");
    }
  }, 10000);

  it("is a guard: without a file, tools are listed as before", async () => {
    const project = temp();
    mkdirSync(join(project, ".git"));
    const s = startServer(project);
    try {
      await s.running;
      await s.request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      const list = await s.request(2, "tools/list");
      expect(list.result?.tools.length).toBe(49);
    } finally {
      s.p.kill("SIGKILL");
    }
  }, 10000);
});

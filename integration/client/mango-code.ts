// The attach client: how another app finds (or starts) Mango Code and uses it without a window.
// The contract is in docs/INTEGRATION.md; this file is only its code, with the routes of the agent
// server (opencode) and of the engine manager. No dependencies: fetch and event streaming from
// the runtime (Bun or Node 18+).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The content of `service.json`, which Mango Code writes when it is ready and removes on exit. */
export interface Service {
  version: number;
  pid: number;
  /** The agent server: sessions, events, permissions, questions, tools. */
  agent: string;
  /** The engine manager: loaded model, GPUs, release and resume. */
  engine: string;
  /** false if it was started with --service (no window). */
  window: boolean;
  /** Only in the file of a Mango Code that is not ready (see `notReady`), which then has neither `agent` nor `engine`. */
  reason?: string;
}

/** The Mango Code data folder (`MANGO_DATA` if set, as the app does). */
export function dataDir(): string {
  return process.env.MANGO_DATA ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "MangoCode");
}

/** The installed app's executable. */
export function executable(): string {
  return path.join(process.env.LOCALAPPDATA ?? "", "Mango Code", "mango-code.exe");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why Mango Code is running but not ready, if it says so: startup failed, or it waits for the models to
 * download to be chosen in its window (first run). Mango Code writes the file with `reason` instead of
 * `agent` and `engine`; it stands while the `pid` process lives.
 */
export function notReady(dir = dataDir()): string | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, "service.json"), "utf8"));
    return typeof s.reason === "string" && alive(s.pid) ? s.reason : null;
  } catch {
    return null;
  }
}

/** Mango Code running and ready, if it is: the file exists, the process is alive and the agent answers. */
export async function find(dir = dataDir()): Promise<Service | null> {
  const f = path.join(dir, "service.json");
  if (!fs.existsSync(f)) return null;
  let s: Service;
  try {
    s = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
  if (!alive(s.pid) || s.reason !== undefined) return null;
  try {
    const r = await fetch(`${s.agent}/global/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? s : null;
  } catch {
    return null;
  }
}

/** Finds Mango Code, or starts it without a window and waits until it is ready (the first start loads the model). */
export async function launch(opts: { exe?: string; dataDir?: string; timeoutMs?: number } = {}): Promise<Service> {
  const dir = opts.dataDir ?? dataDir();
  const found = await find(dir);
  if (found) return found;
  const exe = opts.exe ?? executable();
  if (!fs.existsSync(exe)) throw new Error(`Mango Code is not installed: ${exe} is missing`);
  const child = spawn(exe, ["--service"], { detached: true, stdio: "ignore" });
  child.unref();
  const t0 = Date.now();
  const timeout = opts.timeoutMs ?? 300_000;
  for (;;) {
    const s = await find(dir);
    if (s) return s;
    const reason = notReady(dir);
    if (reason) throw new Error(`Mango Code is not ready: ${reason}`);
    if (Date.now() - t0 > timeout) throw new Error(`Mango Code is not ready after ${timeout / 1000} s (log in ${path.join(dir, "logs")})`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export interface AgentEvent {
  type: string;
  properties: any;
}

/** What happens in a session, already interpreted (see `MangoCode.turn`). */
export type Step =
  | { type: "text"; delta: string; part: string }
  | { type: "reasoning"; delta: string; part: string }
  | { type: "tool"; name: string; status: "pending" | "running" | "completed" | "error"; input: any; output?: string; error?: string; part: string }
  | { type: "permission"; id: string; request: any }
  | { type: "question"; id: string; questions: { question: string; options?: { label: string }[]; multiple?: boolean }[] }
  | { type: "error"; error: any }
  | { type: "end" };

export type Rule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" };
export type McpServer =
  | { type: "local"; command: string[]; environment?: Record<string, string>; cwd?: string; enabled?: boolean }
  | { type: "remote"; url: string; headers?: Record<string, string>; enabled?: boolean };

export interface MessageOptions {
  /** Model key (mango-models.json, e.g. "toq"); without it, the session's model or the default. */
  model?: string;
  /** Instructions added to the system prompt for this message. */
  system?: string;
  /** Attached images or files (a model without vision receives only the name). */
  attachments?: { mime: string; data: Uint8Array | string; name?: string }[];
}

export class MangoCode {
  constructor(readonly service: Service) {}

  private q(directory: string) {
    return `directory=${encodeURIComponent(directory)}`;
  }

  private async call(method: string, url: string, body?: unknown): Promise<any> {
    const r = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }

  // --- sessions ----------------------------------------------------------------------------------

  /** Opens a new session on `directory`. `permissions`: the session's rules (e.g. "ask" on bash). */
  async createSession(directory: string, opts: { title?: string; permissions?: Rule[] } = {}): Promise<string> {
    const s = await this.call("POST", `${this.service.agent}/session?${this.q(directory)}`, {
      title: opts.title,
      permission: opts.permissions,
    });
    return s.id;
  }

  /** The sessions of the folder (stable id, saved on disk: resume one with `send`). */
  async sessions(directory: string): Promise<{ id: string; title: string; time: { created: number; updated: number } }[]> {
    return this.call("GET", `${this.service.agent}/session?${this.q(directory)}`);
  }

  async messages(id: string, directory: string): Promise<any[]> {
    return this.call("GET", `${this.service.agent}/session/${id}/message?${this.q(directory)}`);
  }

  /** Sends a message and returns at once; also while the agent works (it is queued). The answers arrive as events. */
  async send(id: string, directory: string, text: string, opts: MessageOptions = {}): Promise<void> {
    const parts: any[] = [{ type: "text", text }];
    for (const a of opts.attachments ?? []) {
      const b64 = typeof a.data === "string" ? a.data : Buffer.from(a.data).toString("base64");
      parts.push({ type: "file", mime: a.mime, filename: a.name, url: `data:${a.mime};base64,${b64}` });
    }
    await this.call("POST", `${this.service.agent}/session/${id}/prompt_async?${this.q(directory)}`, {
      parts,
      system: opts.system,
      model: opts.model ? { providerID: "mango", modelID: opts.model } : undefined,
    });
  }

  /** Stops the running turn. */
  async abort(id: string, directory: string): Promise<void> {
    await this.call("POST", `${this.service.agent}/session/${id}/abort?${this.q(directory)}`);
  }

  // --- events ------------------------------------------------------------------------------------

  /** The server's raw events for the folder; returns the function that stops listening. */
  listen(directory: string, on: (e: AgentEvent) => void): () => void {
    const ctl = new AbortController();
    (async () => {
      const r = await fetch(`${this.service.agent}/event?${this.q(directory)}`, { signal: ctl.signal });
      const rd = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await rd.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split("\n")) if (line.startsWith("data: ")) on(JSON.parse(line.slice(6)));
        }
      }
    })().catch(() => {});
    return () => ctl.abort();
  }

  /**
   * One turn of the session: sends the message and yields the steps (text in pieces, tools with their
   * result, permissions, questions) until the agent is idle again.
   */
  async *turn(id: string, directory: string, text: string, opts: MessageOptions = {}): AsyncGenerator<Step> {
    const queue: Step[] = [];
    let wake: (() => void) | null = null;
    const partType = new Map<string, string>();
    const push = (s: Step) => {
      queue.push(s);
      wake?.();
    };
    const stop = this.listen(directory, (e) => {
      const p = e.properties ?? {};
      if (p.sessionID && p.sessionID !== id) return;
      switch (e.type) {
        case "message.part.updated": {
          const part = p.part;
          partType.set(part.id, part.type);
          if (part.type === "tool") {
            push({ type: "tool", name: part.tool, status: part.state.status, input: part.state.input, output: part.state.output, error: part.state.error, part: part.id });
          }
          break;
        }
        case "message.part.delta":
          if (p.field === "text") push({ type: partType.get(p.partID) === "reasoning" ? "reasoning" : "text", delta: p.delta, part: p.partID });
          break;
        case "permission.asked":
          push({ type: "permission", id: p.id, request: p });
          break;
        case "question.asked":
          push({ type: "question", id: p.id, questions: p.questions });
          break;
        case "session.error":
          push({ type: "error", error: p.error });
          break;
        case "session.idle":
          push({ type: "end" });
          break;
      }
    });
    try {
      // The event stream must be connected before the message, or the first pieces are lost.
      await new Promise((r) => setTimeout(r, 300));
      await this.send(id, directory, text, opts);
      for (;;) {
        while (queue.length) {
          const s = queue.shift()!;
          yield s;
          if (s.type === "end") return;
        }
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    } finally {
      stop();
    }
  }

  // --- permissions and questions -----------------------------------------------------------------

  async replyPermission(directory: string, id: string, reply: "once" | "always" | "reject", message?: string): Promise<void> {
    await this.call("POST", `${this.service.agent}/permission/${id}/reply?${this.q(directory)}`, { reply, message });
  }

  /** `answers`: for each question, the list of chosen labels (in the order of the questions). */
  async replyQuestion(directory: string, id: string, answers: string[][]): Promise<void> {
    await this.call("POST", `${this.service.agent}/question/${id}/reply?${this.q(directory)}`, { answers });
  }

  async rejectQuestion(directory: string, id: string): Promise<void> {
    await this.call("POST", `${this.service.agent}/question/${id}/reject?${this.q(directory)}`);
  }

  // --- tools and models --------------------------------------------------------------------------

  /** Adds an MCP server to the folder, for all its sessions, as long as Mango Code stays on. */
  async addMcp(directory: string, name: string, config: McpServer): Promise<void> {
    await this.call("POST", `${this.service.agent}/mcp?${this.q(directory)}`, { name, config: { enabled: true, ...config } });
  }

  /**
   * Declares the extra folders of the context of `directory` (absolute paths of existing folders): their
   * `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md` and `.claude/skills` are read like those of the
   * working folder. It is the whole list: it replaces the previous one. The same list again does nothing
   * (`changed: false`); a different list reloads the folder, so declare it before opening sessions.
   * The list stands as long as Mango Code stays on.
   */
  async setExtraFolders(directory: string, folders: string[]): Promise<{ folders: string[]; changed: boolean }> {
    return this.call("PUT", `${this.service.agent}/mango/extra-folders?${this.q(directory)}`, { folders });
  }

  /** The state of the folder's MCP servers: name -> `{ status: "connected" | "failed" | "disabled", error? }`. */
  async mcpStatus(directory: string): Promise<Record<string, { status: string; error?: string }>> {
    return this.call("GET", `${this.service.agent}/mcp?${this.q(directory)}`);
  }

  /** The offered models: key, name, context, images. */
  async models(directory: string): Promise<{ key: string; name: string; context: number; images: boolean }[]> {
    const v = await this.call("GET", `${this.service.agent}/config/providers?${this.q(directory)}`);
    const mango = (v.providers ?? []).find((p: any) => p.id === "mango");
    return Object.values(mango?.models ?? {}).map((m: any) => ({
      key: m.id,
      name: m.name,
      context: m.limit?.context,
      images: Boolean(m.capabilities?.input?.image),
    }));
  }

  // --- engine and GPUs ---------------------------------------------------------------------------

  /** The engine manager's state (`GET /engine`). */
  async engine(): Promise<any> {
    return this.call("GET", `${this.service.engine}/engine`);
  }

  /**
   * Releases the GPUs (PCI indexes; without them, all) for another heavy job. Waits for the running requests
   * to finish (60 s at most: then they drop), saves and stops the engine; returns when the GPUs are free.
   * Usually 1-2 s; while it waits `engine().phase` is `releasing`. If a model is loading it first waits for
   * the load to end (up to 300 s). The loan belongs to this process: if it exits without `resume`, the
   * engine resumes by itself. See docs/INTEGRATION.md, section 6.
   */
  async release(gpus?: number[]): Promise<any> {
    return this.call("POST", `${this.service.engine}/engine/release`, gpus ? { gpus } : {});
  }

  /** Gives the GPUs back to the engine and reloads the model; returns when it is ready. */
  async resume(): Promise<any> {
    return this.call("POST", `${this.service.engine}/engine/resume`, {});
  }

  /** Loads a model without waiting for a session (e.g. before a long job). */
  async startModel(model: string): Promise<any> {
    return this.call("POST", `${this.service.engine}/engine/model`, { model });
  }
}

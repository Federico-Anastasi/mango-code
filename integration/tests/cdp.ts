// A minimal CDP client to drive the web UI inside the app's window (WebView2 with remote debugging):
// evaluate code in the page, collect console messages and exceptions, take screenshots, listen to its events.

export interface Page {
  /** The id of the target in the browser's list of pages. */
  id: string;
  evaluate: (expression: string) => Promise<any>;
  send: (method: string, params?: object) => Promise<any>;
  /** Console messages and exceptions of the page, in order. */
  console: string[];
  /** Calls `handler` with the params of every event `method` of the page (a domain enabled with `send`). */
  on: (method: string, handler: (params: any) => void) => void;
  close: () => void;
}

export async function page(port: number, choose: (t: { url: string; type: string; id: string }) => boolean, waitMs = 60_000): Promise<Page> {
  const t0 = Date.now();
  let target: any;
  while (!target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t: any) => t.type === "page" && choose(t));
    } catch {}
    if (!target) {
      if (Date.now() - t0 > waitMs) throw new Error(`no suitable page on remote debugging ${port}`);
      await Bun.sleep(500);
    }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, ko) => {
    ws.onopen = ok;
    ws.onerror = ko;
  });
  let n = 0;
  const pending = new Map<number, (v: any) => void>();
  const console: string[] = [];
  const handlers: { method: string; handler: (params: any) => void }[] = [];
  ws.onmessage = (m) => {
    const v = JSON.parse(String(m.data));
    for (const h of handlers) if (h.method === v.method) h.handler(v.params);
    if (v.id) pending.get(v.id)?.(v);
    else if (v.method === "Runtime.consoleAPICalled") console.push(`${v.params.type}: ${v.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ")}`);
    else if (v.method === "Runtime.exceptionThrown") console.push(`EXCEPTION: ${v.params.exceptionDetails?.exception?.description ?? v.params.exceptionDetails?.text}`);
  };
  const send = (method: string, params: object = {}) =>
    new Promise<any>((ok) => {
      const id = ++n;
      pending.set(id, ok);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Runtime.enable");
  const evaluate = async (expression: string) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { id: target.id, evaluate, send, console, on: (method, handler) => void handlers.push({ method, handler }), close: () => ws.close() };
}

/**
 * The page of the Mango Code window at `agent`. A hidden window of the app (the one that reads the browser's old storage) is
 * at the same address for a moment and has no bridge: the page that has it is the interface.
 */
export async function windowPage(port: number, agent: string, waitMs = 120_000): Promise<Page> {
  const t0 = Date.now();
  const rejected = new Set<string>();
  for (;;) {
    const candidate = await page(port, (t) => t.url.startsWith(agent) && !rejected.has(t.id), Math.max(1_000, waitMs - (Date.now() - t0)));
    if (await candidate.evaluate(`typeof window.__MANGO_DESKTOP__ === "object"`).catch(() => false)) return candidate;
    candidate.close();
    rejected.add(candidate.id);
    if (Date.now() - t0 > waitMs) throw new Error(`no page of the window at ${agent} on remote debugging ${port}`);
    await Bun.sleep(300);
  }
}

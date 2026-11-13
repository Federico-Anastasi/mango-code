// A minimal CDP client to drive the web UI inside the app's window (WebView2 with remote debugging):
// evaluate code in the page, collect console messages and exceptions, take screenshots, listen to its events.

export interface Page {
  evaluate: (expression: string) => Promise<any>;
  send: (method: string, params?: object) => Promise<any>;
  /** Console messages and exceptions of the page, in order. */
  console: string[];
  /** Calls `handler` with the params of every event `method` of the page (a domain enabled with `send`). */
  on: (method: string, handler: (params: any) => void) => void;
  close: () => void;
}

export async function page(port: number, choose: (t: { url: string; type: string }) => boolean, waitMs = 60_000): Promise<Page> {
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
  return { evaluate, send, console, on: (method, handler) => void handlers.push({ method, handler }), close: () => ws.close() };
}

import { stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import type { Browser, Item, Page, Picture } from "@/mango-harness/contracts"
import { LOOK_SIDE } from "@/mango-harness/look"

type Params = Record<string, unknown>
type Cdp = {
  send: <T>(method: string, params?: Params, sessionId?: string) => Promise<T>
  on: <T>(method: string, listener: (params: T) => void) => void
  close: () => void
}

const SETTLE_QUIET_MS = 300
const SETTLE_MAX_MS = 5000

const KEYS: Record<string, { key: string; vk: number; text?: string }> = {
  enter: { key: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", vk: 9 },
  escape: { key: "Escape", vk: 27 },
  backspace: { key: "Backspace", vk: 8 },
  delete: { key: "Delete", vk: 46 },
  arrowleft: { key: "ArrowLeft", vk: 37 },
  arrowup: { key: "ArrowUp", vk: 38 },
  arrowright: { key: "ArrowRight", vk: 39 },
  arrowdown: { key: "ArrowDown", vk: 40 },
  home: { key: "Home", vk: 36 },
  end: { key: "End", vk: 35 },
  pageup: { key: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", vk: 34 },
}

// Runs inside the page. Leaves the controls it listed in window.__hbControls so that `act` can find the same ones.
const SNAPSHOT_SCRIPT = String.raw`(() => {
  const MAX = 400;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "IFRAME", "CANVAS", "SVG", "OPTION", "OPTGROUP"]);
  // What a person sees: an element made transparent or invisible is not shown, as one with no box is not.
  const SHOWN = { opacityProperty: true, visibilityProperty: true };
  const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image"]);
  const items = [];
  const controls = [];
  let buffer = "";
  let more = false;
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const flush = () => {
    const text = norm(buffer);
    buffer = "";
    if (!text) return;
    if (items.length < MAX) items.push({ text });
    else more = true;
  };
  const sized = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const kindOf = (el) => {
    if (el.tagName === "A") return el.hasAttribute("href") ? "link" : null;
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") return "button";
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return "field";
    if (el.tagName !== "INPUT") return null;
    const type = (el.type || "text").toLowerCase();
    if (type === "hidden") return null;
    return BUTTON_INPUTS.has(type) ? "button" : "field";
  };
  const textOf = (node, root) => {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1 || SKIP.has(node.tagName.toUpperCase()) || !node.checkVisibility(SHOWN)) return "";
    if (node !== root && kindOf(node)) return "";
    return Array.from(node.childNodes).map((child) => textOf(child, root)).join("");
  };
  const describe = (el, kind) => {
    const aria = norm(el.getAttribute("aria-label"));
    if (kind === "link") {
      const image = el.querySelector("img[alt]");
      return norm(textOf(el, el)) || aria || norm(image && image.alt) || norm(el.title) || el.getAttribute("href");
    }
    if (kind === "button") {
      const own = el.tagName === "INPUT" ? el.value : textOf(el, el);
      return norm(own) || aria || norm(el.title) || norm(el.alt) || norm(el.name) || el.type || "button";
    }
    const labels = Array.from(el.labels || []).map((label) => norm(textOf(label, label))).filter(Boolean).join(" ");
    const base = (aria || labels || norm(el.placeholder) || norm(el.name) || norm(el.title) || el.tagName.toLowerCase()).replace(/:$/, "");
    // A list to choose from shows what is chosen and what can be: the options are typed by their text.
    const value = el.tagName === "SELECT"
      ? norm(Array.from(el.selectedOptions).map((option) => option.text).join(", ")) +
        " (options: " + Array.from(el.options).map((option) => norm(option.text)).join(" | ") + ")"
      : el.type === "checkbox" || el.type === "radio"
        ? (el.checked ? "checked" : "unchecked")
        : el.value;
    return value ? base + ": " + value : base;
  };
  const walk = (node, hideText) => {
    if (items.length >= MAX) {
      if (node.nodeType === 3 ? norm(node.nodeValue) : node.nodeType === 1 && !SKIP.has(node.tagName.toUpperCase()) && (norm(node.textContent) || kindOf(node))) more = true;
      return;
    }
    if (node.nodeType === 3) {
      const parent = node.parentElement;
      if (!hideText && parent && getComputedStyle(parent).visibility !== "hidden") buffer += node.nodeValue;
      return;
    }
    if (node.nodeType !== 1 || SKIP.has(node.tagName.toUpperCase()) || !node.checkVisibility(SHOWN)) return;
    if (node.tagName === "BR") {
      buffer += " ";
      return;
    }
    const style = getComputedStyle(node);
    const kind = kindOf(node);
    if (kind) {
      if (style.visibility === "hidden" || !sized(node)) return;
      flush();
      controls.push(node);
      items.push({ control: kind, label: describe(node, kind) });
      return;
    }
    const inline = style.display.startsWith("inline") || style.display === "contents" || style.display === "table-cell";
    const labelsVisibleField = node.tagName === "LABEL" && node.control && kindOf(node.control) === "field"
      && node.control.checkVisibility(SHOWN) && sized(node.control);
    if (!inline) flush();
    if (style.display === "table-cell" && norm(buffer)) buffer += " | ";
    Array.from(node.childNodes).forEach((child) => walk(child, hideText || Boolean(labelsVisibleField)));
    if (!inline) flush();
  };
  if (document.body) walk(document.body, false);
  flush();
  window.__hbControls = controls;
  // What the text cannot carry: a canvas, a drawing or a picture with no description, big enough to be more than an icon;
  // buttons told apart by their colour.
  const drawn = Array.from(document.querySelectorAll("canvas, svg, video, img")).some((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 48 && r.height >= 48 && el.checkVisibility(SHOWN) && !el.closest("a, button, [role=button]")
      && (el.tagName !== "IMG" || !norm(el.alt));
  });
  const tints = new Set(
    Array.from(document.querySelectorAll("button, [role=button], input[type=button], input[type=submit]"))
      .filter((el) => sized(el) && el.checkVisibility(SHOWN))
      .map((el) => getComputedStyle(el).backgroundColor)
      .filter((color) => !/, 0\)$|transparent/.test(color)),
  );
  const unseen = drawn || tints.size > 1;
  return { title: norm(document.title), items, unseen, more };
})()`

// Finds control n of the last snapshot, brings it into view and gives it the focus when the action needs it.
const locateScript = (n: number, action: string): string => String.raw`((n, action) => {
  const list = window.__hbControls || [];
  const el = list[n - 1];
  if (!el) return { error: "There is no control " + n + " on the page; it has " + list.length + "." };
  if (!el.isConnected) return { error: "Control " + n + " is no longer on the page; look at the page again." };
  el.scrollIntoView({ block: "center", inline: "center" });
  if (action !== "click") el.focus();
  if (action === "type" && typeof el.select === "function") el.select();
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName, type: el.type || "" };
})(${n}, ${JSON.stringify(action)})`

export const connect = async (url: string, onClose: () => void): Promise<Cdp> => {
  const socket = new WebSocket(url)
  await new Promise<void>((done, fail) => {
    socket.onopen = () => done()
    socket.onerror = () => fail(new Error("Cannot connect to the browser's debugging port."))
  })
  const calls = new Map<number, { done: (value: unknown) => void; fail: (error: Error) => void }>()
  const listeners = new Map<string, (params: never) => void>()
  let nextId = 1
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number
      method?: string
      params?: Params
      result?: unknown
      error?: { message: string }
    }
    if (message.id === undefined) {
      listeners.get(message.method ?? "")?.((message.params ?? {}) as never)
      return
    }
    const call = calls.get(message.id)
    calls.delete(message.id)
    if (message.error) call?.fail(new Error(message.error.message))
    else call?.done(message.result)
  }
  socket.onclose = () => {
    calls.forEach((call) => call.fail(new Error("The browser closed the connection.")))
    calls.clear()
    onClose()
  }
  return {
    send: <T>(method: string, params: Params = {}, sessionId?: string) =>
      new Promise<T>((done, fail) => {
        const id = nextId++
        calls.set(id, { done: done as (value: unknown) => void, fail })
        socket.send(JSON.stringify({ id, method, params, sessionId }))
      }),
    on: (method, listener) => listeners.set(method, listener as (params: never) => void),
    close: () => socket.close(),
  }
}

// The window of Mango Code itself answers on the same kind of port when remote debugging is on for the whole app:
// navigating it would replace the app with the page.
const isAppWindow = (page: { type: string; url: string; title: string }): boolean =>
  page.type === "page" &&
  (/^https?:\/\/tauri\.localhost\//.test(page.url) ||
    (page.title === "Mango Code" && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(page.url)))

/** The browser of the harness inside the app's preview panel, reached through the debugging port the app announces in
 *  `MANGO_PANEL_CDP`. The panel is one surface: the page it shows is the one the model works on. */
export const openPanelBrowser = (options: { project: string; env?: Record<string, string | undefined> }): Browser => {
  const env = options.env ?? process.env
  const project = resolve(options.project)
  let live: { cdp: Cdp; sessionId: string; scriptId: string } | undefined
  const servers = new Map<string, ReturnType<typeof Bun.serve>>()
  let opened = false
  let activity = Date.now()
  let errors = new Set<string>()
  let dialogs: string[] = []
  const pending = new Set<string>()
  const navigation: { status?: number } = {}

  const send = <T>(method: string, params: Params = {}): Promise<T> =>
    live ? live.cdp.send<T>(method, params, live.sessionId) : Promise.reject(new Error("The browser is not connected."))

  const evaluate = async <T>(expression: string): Promise<T> => {
    const reply = await send<{
      result: { value: T }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (reply.exceptionDetails)
      throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
    return reply.result.value
  }

  const close = async (): Promise<void> => {
    const connection = live
    live = undefined
    opened = false
    if (connection) {
      await Promise.all([
        connection.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: connection.scriptId }, connection.sessionId),
        connection.cdp.send("Runtime.removeBinding", { name: "hbMutation" }, connection.sessionId),
        connection.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }, connection.sessionId),
      ]).catch(() => undefined)
      connection.cdp.close()
    }
    servers.forEach((server) => server.stop(true))
    servers.clear()
  }

  const connectPanel = async (): Promise<Error | undefined> => {
    const port = Number(env.MANGO_PANEL_CDP ?? 0)
    if (!Number.isInteger(port) || port <= 0) return new Error("There is no browser here: the app's panel is not available.")
    const reached = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) }).then(
      async (response) => (response.ok ? ((await response.json()) as { webSocketDebuggerUrl?: string }) : undefined),
      () => undefined,
    )
    if (!reached?.webSocketDebuggerUrl) return new Error("The app's panel does not answer, so no page can be opened.")
    const cdp = await connect(reached.webSocketDebuggerUrl, () => {
      live = undefined
      opened = false
    })
    let sessionId: string
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>(
        "Target.getTargets",
      )
      const pages = targetInfos.filter((target) => target.type === "page")
      if (pages.some(isAppWindow)) {
        cdp.close()
        return new Error("This port shows Mango Code's own window, not the panel: no page can be opened.")
      }
      // The panel has no tabs: a new target would be a window of its own, outside the app.
      const targetId =
        pages[0]?.targetId ??
        (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId
      sessionId = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId
    } catch (cause) {
      cdp.close()
      throw cause
    }

    const touch = () => {
      activity = Date.now()
    }
    ;[
      "Page.frameStartedLoading",
      "Page.frameNavigated",
      "Page.frameStoppedLoading",
      "Page.loadEventFired",
      "Runtime.bindingCalled",
    ].forEach((method) => cdp.on(method, touch))
    cdp.on<{ requestId: string }>("Network.requestWillBeSent", ({ requestId }) => {
      pending.add(requestId)
      touch()
    })
    // The first document after a navigation is the page itself; those after it are its frames.
    cdp.on<{ type: string; response: { status: number } }>("Network.responseReceived", ({ type, response }) => {
      if (type === "Document" && navigation.status === undefined) navigation.status = response.status
    })
    ;["Network.loadingFinished", "Network.loadingFailed"].forEach((method) =>
      cdp.on<{ requestId: string }>(method, ({ requestId }) => {
        pending.delete(requestId)
        touch()
      }),
    )
    cdp.on<{ type: string; args: { value?: unknown; description?: string; type: string }[] }>(
      "Runtime.consoleAPICalled",
      ({ type, args }) => {
        if (type !== "error") return
        const line = args
          .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type)))
          .join(" ")
        errors.add(line.split("\n")[0] ?? line)
      },
    )
    cdp.on<{
      exceptionDetails: {
        text: string
        lineNumber: number
        url?: string
        exception?: { description?: string; value?: unknown }
      }
    }>("Runtime.exceptionThrown", ({ exceptionDetails: { text, lineNumber, url: source, exception } }) => {
      const detail = exception?.description?.split("\n")[0] ?? String(exception?.value ?? "")
      const message = text.includes(detail) ? text : `${text} ${detail}`
      const file = source ? `${basename(new URL(source).pathname)} ` : ""
      errors.add(`${message} (${file}line ${lineNumber + 1})`)
    })
    cdp.on<{ entry: { level: string; text: string; url?: string } }>("Log.entryAdded", ({ entry }) => {
      if (entry.level !== "error") return
      errors.add(entry.url ? `${entry.text}: ${entry.url}` : entry.text)
    })
    cdp.on<{ type: string; message: string; defaultPrompt?: string }>(
      "Page.javascriptDialogOpening",
      ({ type, message, defaultPrompt }) => {
        if (type !== "beforeunload") dialogs.push(message)
        send("Page.handleJavaScriptDialog", { accept: true, promptText: defaultPrompt ?? "" }).catch(() => undefined)
      },
    )

    live = { cdp, sessionId, scriptId: "" }
    const [, , , , , , added] = await Promise.all([
      send("Page.enable"),
      send("Runtime.enable"),
      send("Network.enable"),
      send("Log.enable"),
      send("Emulation.setFocusEmulationEnabled", { enabled: true }),
      send("Runtime.addBinding", { name: "hbMutation" }),
      send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
        source: `new MutationObserver(() => { try { window.hbMutation(""); } catch {} }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });`,
      }),
    ])
    live.scriptId = added.identifier
    return undefined
  }

  // A file of the project opens on the address the app serves it at; without the app, on a server of this process.
  const fileAddress = async (target: string): Promise<string | Error> => {
    const path = resolve(target)
    const found = await stat(path).catch(() => undefined)
    if (!found?.isFile()) return new Error(`${target} does not exist.`)
    const control = env.MANGO_CONTROL_URL
    if (control) {
      const site = await fetch(`${control}/control/site`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
        signal: AbortSignal.timeout(5000),
      }).then(
        async (response) => (response.ok ? ((await response.json()) as { url?: string }) : undefined),
        () => undefined,
      )
      if (site?.url) return site.url
    }
    const from = relative(project, path)
    const root = from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from) ? dirname(path) : project
    const server =
      servers.get(root) ??
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const served = resolve(root, `.${decodeURIComponent(new URL(request.url).pathname)}`)
          const within = relative(root, served)
          const file = Bun.file(served)
          if (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within) && (await file.exists()))
            return new Response(file)
          // The browser asks for a favicon on its own; a 404 for it would show up as an error of the page.
          return new Response("Not found", { status: new URL(request.url).pathname === "/favicon.ico" ? 204 : 404 })
        },
      })
    servers.set(root, server)
    return `http://127.0.0.1:${server.port}/${relative(root, path).split(sep).map(encodeURIComponent).join("/")}`
  }

  const settle = async (): Promise<void> => {
    const deadline = Date.now() + SETTLE_MAX_MS
    while (Date.now() < deadline) {
      const quiet = activity + SETTLE_QUIET_MS - Date.now()
      if (pending.size > 0 || quiet > 0) {
        await Bun.sleep(pending.size > 0 ? 50 : quiet)
        continue
      }
      const state = await evaluate<string>("document.readyState").catch(() => "loading")
      if (state === "complete") return
      await Bun.sleep(50)
    }
  }

  const snapshot = async (): Promise<Page> => {
    const { title, items, unseen, more } = await evaluate<{
      title: string
      items: Item[]
      unseen: boolean
      more: boolean
    }>(SNAPSHOT_SCRIPT)
    const address = await evaluate<string>("location.href")
    return {
      title,
      items: [
        ...dialogs.map((message) => ({ text: `Dialog: ${message}` })),
        ...items,
        ...(more ? [{ text: `(The page goes on: only its first ${items.length} items are shown.)` }] : []),
      ],
      errors: [...errors],
      ...(/^https?:\/\//i.test(address) ? { address } : {}),
      ...(unseen ? { unseen: true as const } : {}),
    }
  }

  const pressKey = async (name: string): Promise<boolean> => {
    const spec =
      KEYS[name.toLowerCase()] ??
      (Array.from(name).length === 1 ? { key: name, vk: name.toUpperCase().charCodeAt(0), text: name } : undefined)
    if (!spec) return false
    const event = { key: spec.key, text: spec.text, windowsVirtualKeyCode: spec.vk }
    await send("Input.dispatchKeyEvent", { ...event, type: spec.text ? "keyDown" : "rawKeyDown" })
    await send("Input.dispatchKeyEvent", { ...event, type: "keyUp", text: undefined })
    return true
  }

  const guarded =
    <A extends unknown[]>(run: (...args: A) => Promise<Page | Error>) =>
    (...args: A): Promise<Page | Error> =>
      run(...args).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))

  return {
    close,

    look: async (): Promise<Picture | Error> => {
      if (!opened || !live) return new Error("No page is open.")
      try {
        const view = await evaluate<{ x: number; y: number; width: number; height: number }>(
          "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done({ x: window.scrollX, y: window.scrollY, width: innerWidth, height: innerHeight }))))",
        )
        const { data } = await send<{ data: string }>("Page.captureScreenshot", {
          format: "png",
          clip: { ...view, scale: Math.min(1, LOOK_SIDE / Math.max(view.width, view.height)) },
        })
        return { mime: "image/png", base64: data }
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error))
      }
    },

    view: guarded<[string]>(async (target) => {
      const address = /^https?:\/\//i.test(target) ? target : await fileAddress(target)
      if (address instanceof Error) return address
      // The panel may have replaced its page since the last call: the session of the old one is gone.
      if (live && !(await evaluate("1").then(() => true, () => false))) {
        live.cdp.close()
        live = undefined
      }
      if (!live) {
        const failure = await connectPanel()
        if (failure) {
          await close()
          return failure
        }
      }
      errors = new Set()
      dialogs = []
      pending.clear()
      activity = Date.now()
      navigation.status = undefined
      const { errorText } = await send<{ errorText?: string }>("Page.navigate", { url: address })
      if (errorText) return new Error(`Cannot open ${target}: ${errorText}.`)
      opened = true
      await settle()
      const page = await snapshot()
      return /^https?:\/\//i.test(address) && navigation.status !== undefined
        ? { ...page, status: navigation.status }
        : page
    }),

    back: guarded<[]>(async () => {
      if (!opened) return new Error("No page is open.")
      const { currentIndex, entries } = await send<{ currentIndex: number; entries: { id: number }[] }>(
        "Page.getNavigationHistory",
      )
      if (currentIndex < 1) return new Error("There is no page before this one.")
      errors = new Set()
      dialogs = []
      activity = Date.now()
      await send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id })
      await settle()
      return snapshot()
    }),

    act: guarded<["click" | "type" | "press", number?, string?]>(async (action, on, text) => {
      if (!opened) return new Error("No page is open: view a page first.")
      if (on === undefined && action !== "press") return new Error(`${action} needs the number of a control.`)
      if (text === undefined && action !== "click")
        return new Error(`${action} needs ${action === "type" ? "the text to type" : "the key to press"}.`)
      dialogs = []
      activity = Date.now()

      if (on !== undefined) {
        const place = await evaluate<{ error: string } | { x: number; y: number; tag: string; type: string }>(
          locateScript(on, action),
        )
        if ("error" in place) return new Error(place.error)
        if (action === "click") {
          const at = { x: place.x, y: place.y, button: "left", clickCount: 1 }
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: place.x, y: place.y })
          await send("Input.dispatchMouseEvent", { ...at, type: "mousePressed" })
          await send("Input.dispatchMouseEvent", { ...at, type: "mouseReleased" })
        }
        if (action === "type" && place.tag === "SELECT") {
          const chosen = await evaluate<boolean>(`((el, wanted) => {
            const index = Array.from(el.options).findIndex((option) => [option.text.trim(), option.value].some((candidate) => candidate.toLowerCase() === wanted.toLowerCase()));
            if (index < 0) return false;
            el.selectedIndex = index;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          })(window.__hbControls[${on - 1}], ${JSON.stringify(text)})`)
          if (!chosen) {
            const options = await evaluate<string[]>(
              `Array.from(window.__hbControls[${on - 1}].options).map((option) => option.text.trim())`,
            )
            return new Error(`Control ${on} has no option "${text}". Its options: ${options.join(" | ")}.`)
          }
        }
        const typable =
          place.tag === "TEXTAREA" ||
          (place.tag === "INPUT" && !["checkbox", "radio", "file", "range", "color"].includes(place.type))
        if (action === "type" && place.tag !== "SELECT" && !typable)
          return new Error(`Control ${on} cannot be typed into.`)
        if (action === "type" && typable) {
          await send("Input.insertText", { text })
          await evaluate("document.activeElement.dispatchEvent(new Event('change', { bubbles: true }))")
        }
      }

      if (action === "press" && !(await pressKey(text ?? ""))) {
        return new Error(
          `Unknown key "${text}": use Enter, Tab, Escape, Backspace, Delete, an arrow, Home, End, PageUp, PageDown or a single character.`,
        )
      }
      await settle()
      return snapshot()
    }),
  }
}

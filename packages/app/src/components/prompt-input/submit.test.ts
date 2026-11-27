import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createServer } from "node:http"
import { createStore } from "solid-js/store"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let Worktree: typeof import("@/utils/worktree").Worktree
let ServerScope: typeof import("@/utils/server-scope").ServerScope

const createdClients: string[] = []
const createdSessions: string[] = []
const sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  location?: { directory: string }
}> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: Array<{ sessionID: string; id?: string; command: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const sentPrompts: string[] = []
const promptInputs: unknown[] = []
const sentCommands: unknown[] = []
const commands: Array<{ name: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
const pictureKept: unknown[] = []
/** What was put in the box after it was emptied. */
const promptSets: Prompt[] = []
/** What the conversation was said to be doing, in order. */
const statuses: string[] = []
/** The sentence the agent refuses a picture with; none when it takes it. */
let pictureRefusal: string | undefined
/** What the agent's picture route got, and the address it listens on. */
const pictureRoutes: Array<{ url: string; method: string; type: string | null; body: unknown }> = []
// A plain http server: the page's own Response (the test's DOM) is not the one Bun.serve takes.
const pictureAgent = createServer((request, response) => {
  // the page's fetch asks first whether it may (a different origin): it may
  const open = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }
  if (request.method === "OPTIONS") return void response.writeHead(204, open).end()
  let body = ""
  request.on("data", (chunk) => (body += chunk))
  request.on("end", () => {
    pictureRoutes.push({
      url: request.url ?? "",
      method: request.method ?? "",
      type: request.headers["content-type"] ?? null,
      body: JSON.parse(body),
    })
    if (pictureRefusal)
      return void response
        .writeHead(409, { ...open, "content-type": "application/json" })
        .end(JSON.stringify({ data: { message: pictureRefusal } }))
    response.writeHead(200, { ...open, "content-type": "application/json" }).end(JSON.stringify({ info: {}, parts: [] }))
  })
})
await new Promise<void>((ok) => pictureAgent.listen(0, "127.0.0.1", ok))
const pictureAddress = `http://127.0.0.1:${(pictureAgent.address() as { port: number }).port}`
afterAll(() => void pictureAgent.close())
let createSessionGate: Promise<void> | undefined
/** The folder name of the worktree the server makes: its state outlives a test, so a test that waits on one names its own. */
let worktreeName = "new"

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  picture: {
    current: () => undefined,
    set: (pick: unknown) => void pictureKept.push(pick),
  },
  reset: () => undefined,
  set: (value: Prompt) => void promptSets.push(value),
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    api: {
      session: {
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          const location = input.location?.directory ?? directory
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          return {
            id: `session-${createdSessions.length}`,
            projectID: "project",
            agent: input.agent,
            model: input.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: `New session ${createdSessions.length}`,
            location: { directory: location },
          }
        },
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          promptInputs.push(input)
          return { data: undefined }
        },
        command: async (input: unknown) => {
          sentCommands.push(input)
        },
        shell: async (input: { sessionID: string; id?: string; command: string }) => {
          sentShell.push(input)
        },
      },
    },
    session: {
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/${worktreeName}` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")
  // only the encoding of a folder in an address is replaced: the rest of the module stays as it is
  const encode = { ...(await import("@opencode-ai/core/util/encode")) }

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    toaster: { show: () => 0, dismiss: () => undefined },
    showToast: () => 0,
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    ...encode,
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/server", () => ({
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        api: rootClient.api,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/server-sdk", () => ({
    useServerSDK: () => () => ({ url: pictureAddress, server: { http: {} } }),
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: commands, model_ready: true },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: (key: string, _id: string, value: { type?: string }) => {
          if (key === "session_status" && value.type) statuses.push(value.type)
        },
        sync: async () => {
          serverSessionSyncs++
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
  Worktree = (await import("@/utils/worktree")).Worktree
  ServerScope = (await import("@/utils/server-scope")).ServerScope
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  sessionCreateInputs.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  sentPrompts.length = 0
  promptInputs.length = 0
  sentCommands.length = 0
  commands.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  createSessionGate = undefined
  worktreeName = "new"
  pictureKept.length = 0
  promptSets.length = 0
  statuses.length = 0
  pictureRefusal = undefined
  pictureRoutes.length = 0
  serverSessionSyncs = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit of a picture", () => {
  const asked = { request: "a red Vespa", format: "portrait", size: "large", model: "pic1" } as const
  const submitWith = (picture: { on: boolean; request: unknown }, extra: Record<string, unknown> = {}) =>
    createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
      picture: {
        on: () => picture.on,
        request: () => picture.request as typeof asked | undefined,
        pick: () => ({ format: "portrait" }),
        hold: () => () => undefined,
      },
      ...extra,
    })
  const send = (submit: ReturnType<typeof submitWith>) =>
    submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

  test("the words go to the agent's route for a picture, not to the model as a message", async () => {
    params = { id: "session-1" }
    await send(submitWith({ on: true, request: asked }))
    await Bun.sleep(50)
    expect(pictureRoutes).toEqual([
      { url: "/session/session-1/image?directory=%2Frepo%2Fmain", method: "POST", type: "application/json", body: asked },
    ])
    expect(sentPrompts).toEqual([])
    expect(optimistic).toEqual([])
  })

  test("a new conversation is created as for a message and opens on the picture side", async () => {
    await send(submitWith({ on: true, request: asked }, { info: () => undefined }))
    await Bun.sleep(50)
    expect(createdSessions).toEqual(["/repo/main"])
    expect(pictureKept).toEqual([{ format: "portrait", mode: "picture" }])
    expect(pictureRoutes.map((route) => route.url)).toEqual(["/session/session-1/image?directory=%2Frepo%2Fmain"])
  })

  test("an agent that refuses the picture gives the words back to the box, and the conversation is not left working", async () => {
    params = { id: "session-1" }
    pictureRefusal = "No model that draws is on this computer."
    promptValue = [{ type: "text", content: "a red Vespa", start: 0, end: 11 }]
    await send(submitWith({ on: true, request: asked }))
    await Bun.sleep(50)
    expect(pictureRoutes).toHaveLength(1)
    expect(statuses).toEqual(["busy", "idle"])
    expect(promptSets).toEqual([[{ type: "text", content: "a red Vespa", start: 0, end: 11 }]])
  })

  test("an attachment made on the text side is not part of the picture and stays in the box", async () => {
    params = { id: "session-1" }
    const attached = { type: "image", id: "a1", filename: "photo.png", mime: "image/png", blob: {} } as unknown as Prompt[number]
    promptValue = [{ type: "text", content: "a red Vespa", start: 0, end: 11 }, attached]
    await send(submitWith({ on: true, request: asked }))
    await Bun.sleep(50)
    expect(pictureRoutes.map((route) => route.body)).toEqual([asked])
    expect(promptSets).toEqual([[{ type: "text", content: "", start: 0, end: 0 }, attached]])
  })

  test("in a new worktree the picture is asked when the worktree is ready, in its folder", async () => {
    worktreeName = "picture-ready"
    await send(submitWith({ on: true, request: asked }, { info: () => undefined, newSessionWorktree: () => "create" }))
    await Bun.sleep(50)
    expect(createdSessions).toEqual(["/repo/main/picture-ready"])
    expect(pictureRoutes).toEqual([])
    Worktree.ready(ServerScope.local, "/repo/main/picture-ready")
    await Bun.sleep(50)
    expect(pictureRoutes.map((route) => route.url)).toEqual([
      "/session/session-1/image?directory=%2Frepo%2Fmain%2Fpicture-ready",
    ])
  })

  test("a worktree that could not be made asks for no picture", async () => {
    worktreeName = "picture-failed"
    await send(submitWith({ on: true, request: asked }, { info: () => undefined, newSessionWorktree: () => "create" }))
    Worktree.failed(ServerScope.local, "/repo/main/picture-failed", "no room on the disk")
    await Bun.sleep(50)
    expect(pictureRoutes).toEqual([])
  })

  test("with the picture side off the words go to the model as ever", async () => {
    params = { id: "session-1" }
    await send(submitWith({ on: false, request: asked }))
    await Bun.sleep(50)
    expect(pictureRoutes).toEqual([])
    expect(sentPrompts).toEqual(["/repo/main"])
  })

  test("words without a model that draws send nothing", async () => {
    params = { id: "session-1" }
    await send(submitWith({ on: true, request: undefined }))
    await Bun.sleep(50)
    expect(pictureRoutes).toEqual([])
    expect(sentPrompts).toEqual([])
  })
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-a" },
      },
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-b" },
      },
    ])
    expect(sentShell).toEqual([
      expect.objectContaining({ sessionID: "session-1", id: expect.stringMatching(/^evt_/), command: "ls" }),
      expect.objectContaining({ sessionID: "session-2", id: expect.stringMatching(/^evt_/), command: "ls" }),
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(serverSessionSyncs).toBe(0)
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await Bun.sleep(0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      text: "ls",
      files: [],
      agents: [],
    })
    expect((promptInputs[0] as { id?: string }).id).toStartWith("msg_")
    expect((promptInputs[0] as { legacyParts?: { id: string; type: string; text?: string }[] }).legacyParts).toEqual([
      { id: expect.stringMatching(/^prt_/), type: "text", text: "ls" },
    ])
  })

  test("submits slash commands through the current session API", async () => {
    params = { id: "session-1" }
    variant = "high"
    commands.push({ name: "review" })
    promptValue = [{ type: "text", content: "/review staged changes", start: 0, end: 22 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands).toEqual([
      {
        sessionID: "session-1",
        id: expect.stringMatching(/^msg_/),
        command: "review",
        arguments: "staged changes",
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: "high" },
        files: [],
      },
    ])
    expect(serverSessionSyncs).toBe(0)
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
    expect(optimisticSeeded).toEqual([true])
  })
})

// mango-code: a message sent while the local model is not ready waits in the interface.
describe("prompt submit while the model is not ready", () => {
  const input = (extra: Partial<Parameters<typeof createPromptSubmit>[0]>) =>
    createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      ...extra,
    })
  const event = { preventDefault: () => undefined } as unknown as Event

  test("the message waits: nothing reaches the server, the draft is handed over, and nothing counts as sent", async () => {
    params = { id: "session-1" }
    const waited: unknown[] = []
    let submitted = 0
    await input({
      shouldWait: () => true,
      onWait: (draft) => void waited.push(draft),
      onSubmit: () => void submitted++,
    }).handleSubmit(event)
    expect(sentPrompts).toEqual([])
    expect(optimistic).toEqual([])
    expect(submitted).toBe(0)
    expect(waited).toEqual([
      expect.objectContaining({
        sessionID: "session-1",
        prompt: [{ type: "text", content: "ls", start: 0, end: 2 }],
        model: { providerID: "provider", modelID: "model" },
      }),
    ])
  })

  test("in a new conversation the conversation is made on the server and the message waits", async () => {
    const waited: { sessionID: string }[] = []
    await input({
      info: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      shouldWait: () => true,
      onWait: (draft) => void waited.push(draft),
    }).handleSubmit(event)
    expect(createdSessions).toEqual(["/repo/worktree-a"])
    expect(waited.map((draft) => draft.sessionID)).toEqual(["session-1"])
    expect(sentPrompts).toEqual([])
  })

  test("a message that waits when sent still waits if the model becomes ready while its conversation is made", async () => {
    let ready = false
    let open = () => {}
    createSessionGate = new Promise<void>((resolve) => (open = resolve))
    const waited: { model: unknown }[] = []
    const sending = input({
      info: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      shouldWait: () => !ready,
      onWait: (draft) => void waited.push(draft),
    }).handleSubmit(event)
    await Bun.sleep(0)
    ready = true
    open()
    await sending
    await Bun.sleep(0)
    expect(sentPrompts).toEqual([])
    expect(waited).toEqual([expect.objectContaining({ model: { providerID: "provider", modelID: "model" } })])
  })

  test("a shell command does not wait, and a message goes as usual when nothing waits", async () => {
    params = { id: "session-1" }
    const waited: unknown[] = []
    await input({ mode: () => "shell", shouldWait: () => true, onWait: (draft) => void waited.push(draft) }).handleSubmit(event)
    expect(sentShell).toHaveLength(1)
    await input({ shouldWait: () => false, onWait: (draft) => void waited.push(draft) }).handleSubmit(event)
    await Bun.sleep(0)
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(waited).toEqual([])
  })
})

import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { formatDuration } from "@opencode-ai/session-ui/step-time"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { authTokenFromCredentials } from "@/utils/server"
import { showToast } from "@/utils/toast"

// mango-code: the programs the agent's commands left running in this conversation (a dev server, a program in the
// background), with "Stop" for each one: route /mango/processes of the agent (shared/mango-processes.ts).
const PROCESSES_PATH = "/mango/processes"
const PROCESSES_STOP_PATH = "/mango/processes/stop"
// A program can also end by itself: the list is read again now and then, and at every change of the conversation.
const POLL_MS = 10_000

export type RunningProgram = { pid: number; started: number; name: string; command: string; asked: string }

/** The list the agent gives; `undefined` for an answer of another shape. */
export function parseRunning(body: unknown): RunningProgram[] | undefined {
  const list = body && typeof body === "object" ? (body as { processes?: unknown }).processes : undefined
  if (!Array.isArray(list)) return
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const value = item as Record<string, unknown>
    if (typeof value.pid !== "number" || typeof value.started !== "number") return []
    return [
      {
        pid: value.pid,
        started: value.started,
        name: typeof value.name === "string" ? value.name : "",
        command: typeof value.command === "string" ? value.command : "",
        asked: typeof value.asked === "string" ? value.asked : "",
      },
    ]
  })
}

export function RunningPrograms(props: { sessionID: string }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const list = createRunningPrograms({
    sessionID: props.sessionID,
    status: () => sync().data.session_status[props.sessionID]?.type,
    request: (path, init = {}) => {
      const sdk = serverSDK()
      // The agent takes a POST to its routes only in JSON.
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (sdk.server.http.password)
        headers.authorization = `Basic ${authTokenFromCredentials({ username: sdk.server.http.username, password: sdk.server.http.password })}`
      return fetch(new URL(path, sdk.url), { ...init, headers, signal: AbortSignal.timeout(10_000) })
    },
  })

  const stop = async (program: RunningProgram) => {
    if (!(await list.stop(program)))
      showToast({ variant: "error", title: language.t("session.running.stopFailed", { name: program.name }) })
  }

  return (
    <Show when={list.state.programs.length > 0}>
      <section
        data-component="running-programs"
        aria-label={language.t("session.running.title")}
        class="shrink-0 flex flex-col gap-1 border-b border-v2-border-border-muted px-3 py-2"
      >
        <div class="text-12-medium text-v2-text-text-muted">{language.t("session.running.title")}</div>
        <For each={list.state.programs}>
          {(program) => (
            <div data-slot="running-program" class="flex min-w-0 items-center gap-3 py-1">
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-13-medium text-v2-text-text-base" title={program.command}>
                  {program.name}
                </span>
                <span class="truncate text-12-regular text-v2-text-text-faint" title={program.asked}>
                  {language.t("session.running.since", {
                    time: formatDuration(list.state.now - program.started, language.t),
                  })}
                  {" · "}
                  {program.asked}
                </span>
              </div>
              <ButtonV2
                variant="outline"
                size="small"
                disabled={list.state.stopping === program.pid}
                onClick={() => void stop(program)}
              >
                {language.t("session.running.stop")}
              </ButtonV2>
            </div>
          )}
        </For>
      </section>
    </Show>
  )
}

/**
 * The list of a conversation, kept up to date. It is read only while the page is visible (a hidden window does not
 * ask), a reading that fails keeps the list as it was, and an agent that refuses it (403: the phone, where the list is
 * the PC's) is not asked again.
 */
export function createRunningPrograms(input: {
  sessionID: string
  status: () => string | undefined
  request: (path: string, init?: RequestInit) => Promise<Response>
}) {
  const [state, setState] = createStore({
    programs: [] as RunningProgram[],
    stopping: undefined as number | undefined,
    now: Date.now(),
    refused: false,
  })

  const timer = setInterval(() => void load(), POLL_MS)
  const load = async () => {
    if (state.refused || document.visibilityState !== "visible") return
    const response = await input
      .request(`${PROCESSES_PATH}?sessionID=${encodeURIComponent(input.sessionID)}`)
      .catch(() => undefined)
    if (response?.status === 403) {
      setState("refused", true)
      clearInterval(timer)
      return
    }
    if (!response?.ok) return
    const programs = parseRunning(await response.json().catch(() => undefined))
    if (programs) setState({ programs, now: Date.now() })
  }

  void load()
  // A command that has just ended may have left something running.
  createEffect(on(input.status, () => void load(), { defer: true }))
  onCleanup(() => clearInterval(timer))
  makeEventListener(document, "visibilitychange", () => void load())

  return {
    state,
    /** Stops a program and reads the list again; `false` if it did not stop. */
    async stop(program: RunningProgram) {
      setState("stopping", program.pid)
      const response = await input
        .request(PROCESSES_STOP_PATH, {
          method: "POST",
          body: JSON.stringify({ sessionID: input.sessionID, pid: program.pid, started: program.started }),
        })
        .catch(() => undefined)
      setState("stopping", undefined)
      await load()
      // 404: it had already ended, or its number now belongs to another program: in both cases it leaves the list.
      return response?.ok === true || response?.status === 404
    },
  }
}

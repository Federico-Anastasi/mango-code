// mango-code: above the composer, the MCP servers of the project's .mcp.json that have not been allowed yet: they
// start programs, so they start only once the user allows them here (agent route `/mango/project-servers`).
import { createResource, createSignal, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@/utils/toast"
import { useAgentCall } from "./settings-page/harnesses"

type ProjectServers = { file: string | null; servers: { name: string; run: string }[]; approved: boolean }

export function ProjectServersLine() {
  const sdk = useSDK()
  const language = useLanguage()
  const call = useAgentCall()
  const [busy, setBusy] = createSignal(false)
  const [found, { mutate }] = createResource(
    () => sdk().directory || undefined,
    async (directory) => (await call("/mango/project-servers", { directory })) as ProjectServers,
  )
  const waiting = () => {
    const value = found.state === "ready" ? found() : undefined
    return value && !value.approved && value.servers.length ? value : undefined
  }
  async function allow() {
    setBusy(true)
    try {
      mutate((await call("/mango/project-servers", { directory: sdk().directory }, { method: "POST", body: "{}" })) as ProjectServers)
    } catch (error) {
      showToast({ variant: "error", title: language.t("mango.projectServers.failed"), description: String((error as Error)?.message ?? error) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Show when={waiting()}>
      {(value) => (
        <div
          role="status"
          data-component="mango-project-servers"
          class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 text-center text-[12px] leading-4 text-v2-text-text-muted"
        >
          <span>
            {language.t("mango.projectServers.line", {
              list: value().servers.map((server) => `${server.name} (${server.run})`).join(", "),
            })}
          </span>
          <ButtonV2 size="small" variant="neutral" data-action="mango-project-servers-allow" disabled={busy()} onClick={allow}>
            {language.t("mango.projectServers.allow")}
          </ButtonV2>
        </div>
      )}
    </Show>
  )
}

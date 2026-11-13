// mango-code: Settings › Computer: what
// Mango Code found in this PC and how it uses it. Every card has «Usa per i modelli», off with its sentence when it cannot
// be changed; where a model that fits one card runs; processor, memory, the engine (with «Aggiorna il motore» when the
// app came with a new one) and the tailored setups, with how they are made (the folder of the skill to give to a
// frontier AI). The changes go through the bridge; without it the controls stay visible, off, with «si fa dal computer».
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import { type Component, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { downloadFailedText } from "@/components/mango-text"
import { engineUpdate, type Computer } from "@/utils/mango-state"
import { SettingsListV2 } from "../settings-v2/parts/list"
import { SettingsRowV2 } from "../settings-v2/parts/row"
import { createCommands, useControl } from "./control"

const MIB = 1024 * 1024

const SMALL = {
  one: { title: "settings.computer.small.one.title", line: "settings.computer.small.one.description" },
  all: { title: "settings.computer.small.all.title", line: "settings.computer.small.all.description" },
} as const

export const SettingsComputer: Component = () => {
  const language = useLanguage()
  const control = useControl()
  const computer = () => window.__MANGO_DESKTOP__?.computer
  const commands = createCommands(control.now)
  const run = commands.run
  const busy = commands.anyBusy
  const size = (mib: number) => formatFileSize(mib * MIB, language.locale())
  // What «Aggiorna il motore» answered: the new version is being downloaded. Shown while there is an update: once the
  // engine has arrived the line says it is this version's. A download of the engine that failed says why instead, with
  // «Riprova», which asks it again.
  const [engineNote, setEngineNote] = createSignal<string>()
  const engineFailed = () => {
    const download = control.view.state && engineUpdate(control.view.state)
    return download?.state === "failed" ? download : undefined
  }
  const engineNoteText = () => {
    const failed = engineFailed()
    return failed ? downloadFailedText(failed, language) : engineNote()
  }
  const updateEngine = async () => {
    setEngineNote(undefined)
    setEngineNote(await run("engine", () => computer()?.updateEngine()))
  }

  const error = (row: string) => (
    <Show when={commands.error(row)}>{(message) => <span class="settings-page-error block">{message()}</span>}</Show>
  )

  return (
    <div class="settings-v2-tab-body" data-component="settings-computer">
      <p class="settings-page-note">{language.t("settings.computer.lead")}</p>
      <Show when={!computer()}>
        <p class="settings-page-note" data-slot="settings-pc-only">
          {language.t("settings.pcOnly")}
        </p>
      </Show>
      <Show when={!control.view.computer}>
        <Show
          when={control.view.failed || control.view.computerFailed}
          fallback={<p class="settings-page-note">{language.t("settings.computer.reading")}</p>}
        >
          <p class="settings-page-error" role="alert">
            {language.t("settings.computer.unreachable")}
          </p>
        </Show>
      </Show>
      <Show when={control.view.computer}>
        {(found) => (
          <>
            <div class="settings-v2-section">
              <h3 class="settings-v2-section-title">{language.t("settings.computer.gpus")}</h3>
              <SettingsListV2>
                <Show
                  when={found().gpus.length}
                  fallback={
                    <SettingsRowV2 title={language.t("settings.computer.noGpu")} description="">
                      {null}
                    </SettingsRowV2>
                  }
                >
                  <For each={found().gpus}>
                    {(gpu) => (
                      <SettingsRowV2
                        title={`${gpu.name} · ${size(gpu.memory_mib)}`}
                        description={
                          <>
                            {gpu.note}
                            {error(gpu.name)}
                          </>
                        }
                      >
                        <label class="settings-page-inline" data-action="settings-gpu-used" data-gpu={gpu.name}>
                          <span>{language.t("settings.computer.useForModels")}</span>
                          <Switch
                            checked={gpu.used}
                            // a card with a sentence cannot be changed: too little memory, not for this engine, or not
                            // one alone with this engine
                            disabled={!computer() || busy() || !!gpu.note}
                            onChange={(checked) => void run(gpu.name, () => computer()?.setGpuUsed(gpu.name, checked))}
                            aria-label={language.t("settings.computer.useCard", { name: gpu.name })}
                          />
                        </label>
                      </SettingsRowV2>
                    )}
                  </For>
                </Show>
              </SettingsListV2>
            </div>

            <div class="settings-v2-section">
              <h3 class="settings-v2-section-title">{language.t("settings.computer.small.section")}</h3>
              <SettingsListV2>
                <SettingsRowV2
                  title={language.t(SMALL[found().small_models].title)}
                  description={
                    <>
                      {language.t(SMALL[found().small_models].line)}
                      {error("small")}
                    </>
                  }
                >
                  <SegmentedControlV2
                    value={found().small_models}
                    disabled={!computer() || busy()}
                    onChange={(value) =>
                      (value === "one" || value === "all") && void run("small", () => computer()?.setSmallModels(value))
                    }
                    data-action="settings-small-models"
                  >
                    <SegmentedControlItemV2 value="one">
                      {language.t("settings.models.where.one")}
                    </SegmentedControlItemV2>
                    <SegmentedControlItemV2 value="all">
                      {language.t("settings.models.where.all")}
                    </SegmentedControlItemV2>
                  </SegmentedControlV2>
                </SettingsRowV2>
              </SettingsListV2>
            </div>

            <div class="settings-v2-section">
              <h3 class="settings-v2-section-title">{language.t("settings.computer.rest")}</h3>
              <SettingsListV2>
                <SettingsRowV2
                  title={language.t("settings.computer.cpu")}
                  description={language.t("settings.computer.cpuLine", {
                    cpu: found().cpu,
                    cores: found().cores,
                    ram: size(found().ram_mib),
                  })}
                >
                  {null}
                </SettingsRowV2>
                <SettingsRowV2
                  title={language.t("settings.computer.engine")}
                  description={
                    <>
                      {engineLine(found(), language.t)}
                      <Show when={found().engine.update && engineNoteText()}>
                        {(note) => (
                          <span class="block" role="status" data-slot="settings-computer-engine-note">
                            {note()}
                          </span>
                        )}
                      </Show>
                      {error("engine")}
                    </>
                  }
                >
                  <Show when={found().engine.update}>
                    <ButtonV2
                      variant="neutral"
                      disabled={!computer() || busy()}
                      onClick={() => void updateEngine()}
                      data-action="settings-computer-update-engine"
                    >
                      {language.t(engineFailed() ? "mango.action.retry" : "settings.computer.updateEngine")}
                    </ButtonV2>
                  </Show>
                </SettingsRowV2>
                <Show when={found().tailored}>
                  {(tailored) => (
                    <SettingsRowV2
                      title={language.t("settings.computer.tailored")}
                      description={
                        <>
                          {language.plural("settings.computer.tailored.models", tailored().models)}
                          {error("optimize")}
                        </>
                      }
                    >
                      <ButtonV2
                        variant="neutral"
                        disabled={!computer() || busy()}
                        onClick={() => void run("optimize", () => computer()?.openOptimize())}
                        data-action="settings-computer-optimize"
                      >
                        {language.t("settings.computer.optimize")}
                      </ButtonV2>
                    </SettingsRowV2>
                  )}
                </Show>
              </SettingsListV2>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

/**
 * «llama.cpp per le schede video · è quello di questa versione di Mango Code», «· c'è una versione nuova», «· non ancora
 * installato».
 */
function engineLine(
  pc: Computer,
  t: (
    key: "settings.computer.engine.current" | "settings.computer.engine.update" | "settings.computer.notInstalled",
  ) => string,
) {
  const state = pc.engine.update
    ? "settings.computer.engine.update"
    : pc.engine.installed
      ? "settings.computer.engine.current"
      : "settings.computer.notInstalled"
  return `${pc.engine.label} · ${t(state)}`
}

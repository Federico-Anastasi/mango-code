// mango-code: the right side of the Home while the app has something to say about the model, at the first
// start and at every start: the welcome with the model to start with while nothing is on the computer, its download
// (the app is already in use: dictation and theme are chosen there), the engine the app came with arriving for the
// models on the disk, the models that cannot be read, the start that failed with the model that fits now, the other
// PC's engine that does not answer. Otherwise the Home as usual. Downloads and the way back from the
// other PC go through the bridge of the app's window: without it (a phone, a browser) they are «done from the computer».
import { createEffect, createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@/context/language"
import { failureText, useMango } from "@/context/mango"
import { DictationRow } from "@/components/settings-page/dictation"
import { mangoDesktopError } from "@/utils/mango-desktop"
import {
  chosenBytes,
  contextLabel,
  contextWords,
  diskDrive,
  engineUpdate,
  homeView,
  mainDownload,
  recommended,
  type CatalogEntry,
  type Download,
} from "@/utils/mango-state"
import {
  cardsText,
  downloadFailedText,
  downloadParts,
  downloadPausedText,
  downloadPercent,
  downloadTitle,
  fitsText,
  queueText,
} from "./mango-text"

type Actions = { onNewProject?: () => void; onOpenFolder: () => void }

export function MangoHomePanel(props: Actions & { children: JSX.Element }) {
  const mango = useMango()
  const language = useLanguage()
  const view = createMemo(() => homeView(mango.state(), mango.catalog(), mango.catalogFailed()))
  const engine = () => {
    const state = mango.state()
    return state && engineUpdate(state)
  }
  return (
    <Switch fallback={props.children}>
      <Match when={view() === "welcome"}>
        <Welcome />
      </Match>
      <Match when={view() === "downloading"}>
        <Downloading {...props} />
      </Match>
      <Match when={view() === "remote"}>
        <RemoteDown />
      </Match>
      <Match when={view() === "engine" && engine()}>
        {(download) => (
          <div class="flex min-w-0 flex-1 flex-col max-md:overflow-y-auto">
            <div class={`max-md:px-4 ${above}`}>
              <DownloadCard download={download()} />
            </div>
            {props.children}
          </div>
        )}
      </Match>
      <Match when={view() === "unreadable"}>
        <div class="flex min-w-0 flex-1 flex-col max-md:overflow-y-auto">
          <div class={`max-md:px-4 ${above}`}>
            <div data-component="mango-unreadable" class={card}>
              <p class={danger}>{language.t("mango.models.unreadable")}</p>
              <div>
                <ButtonV2 variant="ghost" size="small" data-action="mango-unreadable-report" onClick={mango.openHelp}>
                  {language.t("mango.failed.report")}
                </ButtonV2>
              </div>
            </div>
          </div>
          {props.children}
        </div>
      </Match>
      <Match when={mango.state()?.model.phase === "failed"}>
        <div class="flex min-w-0 flex-1 flex-col max-md:overflow-y-auto">
          <div class="max-md:px-4">
            <FailedStart />
          </div>
          {props.children}
        </div>
      </Match>
    </Switch>
  )
}

// It scrolls by itself only where it stands alone (the phone, and beside the projects): between the two the Home scrolls
// it with the projects, and a panel that only looked scrollable would keep «Indietro» and «Scarica e comincia» from
// staying in view at the bottom of the list. Beside the projects it is as high as the Home at most (`100cqh`, the
// Home's scroll view): without that it grew with its list, never scrolled, and the buttons went below the window.
const panel =
  "flex min-w-0 flex-1 flex-col gap-6 pb-16 pt-6 max-md:overflow-y-auto max-md:px-4 lg:max-h-[100cqh] lg:overflow-y-auto lg:pt-12"
const card = "flex flex-col gap-3 rounded-[10px] bg-v2-background-bg-layer-01 p-4"
const title = "text-[20px] leading-7 text-v2-text-text-base [font-weight:530]"
const note = "text-[13px] leading-5 text-v2-text-text-muted"
const danger = "text-[13px] leading-5 text-text-danger"
const row = "flex flex-col items-start rounded-md px-3 py-2 text-left hover:bg-v2-overlay-simple-overlay-hover"
/** A card above the Home as usual: a failed start, the engine arriving, the models that cannot be read. */
const above = "mt-6 lg:mt-12"

/**
 * The language of the interface, by name («Italiano»): in the top bar at the first start, in the welcome on
 * a phone (it has no such bar). Following the system is chosen in the settings.
 */
export function LanguagePicker() {
  const language = useLanguage()
  const options = createMemo(() =>
    language.choices
      .filter((choice) => choice !== "system")
      .map((choice) => ({ value: choice, label: language.label(choice) })),
  )
  return (
    <SelectV2
      appearance="inline"
      data-action="mango-home-language"
      aria-label={language.t("mango.home.language")}
      options={options()}
      placement="bottom-end"
      gutter={6}
      current={options().find((option) => option.value === language.locale())}
      value={(option) => option.value}
      label={(option) => option.label}
      onSelect={(option) => option && language.setChoice(option.value)}
    />
  )
}

/** A button that the bridge makes work; without it, the sentence that says it is done from the computer. */
function BridgeButton(props: { action: string; label: string; disabled?: boolean; onClick: () => void }) {
  const mango = useMango()
  return (
    <Show when={mango.bridge()?.models} fallback={<PcOnly />}>
      <ButtonV2 data-action={props.action} disabled={props.disabled} onClick={props.onClick}>
        {props.label}
      </ButtonV2>
    </Show>
  )
}

function PcOnly() {
  const language = useLanguage()
  return (
    <p data-slot="mango-pc-only" class={note}>
      {language.t("settings.pcOnly")}
    </p>
  )
}

function Welcome() {
  const mango = useMango()
  const language = useLanguage()
  const [choosing, setChoosing] = createSignal(false)
  const [chosen, setChosen] = createSignal<string[]>([])
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const catalog = () => mango.catalog() ?? []
  const proposed = createMemo(() => recommended(catalog()))
  // The recommended model is ticked once: after that the list is the user's, even empty.
  let ticked = false
  createEffect(() => {
    const model = proposed()
    if (!model || ticked) return
    ticked = true
    setChosen([model.key])
  })

  // Busy until the state says the download is there: a second click would ask for it again.
  const download = async (keys: string[]) => {
    const models = mango.bridge()?.models
    if (!models || keys.length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      await models.download(keys)
      await mango.refresh()
    } catch (cause) {
      setError(mangoDesktopError(cause).message)
    } finally {
      setBusy(false)
    }
  }
  const startLabel = () =>
    chosen().length > 1
      ? language.t("mango.home.startMany", {
          count: chosen().length,
          size: formatFileSize(chosenBytes(catalog(), chosen()), language.intl()),
        })
      : language.t("mango.home.start", { size: formatFileSize(chosenBytes(catalog(), chosen()), language.intl()) })

  return (
    <div data-component="mango-welcome" class={panel}>
      <Show
        when={choosing()}
        fallback={
          <>
            <div class="flex items-start justify-between gap-3">
              <div class="flex flex-col gap-1">
                <h2 class={title}>{language.t("mango.home.welcome.title")}</h2>
                <p class={note}>{language.t("mango.home.welcome.body")}</p>
              </div>
              <div class="md:hidden">
                <LanguagePicker />
              </div>
            </div>
            <Found />
            <Show when={proposed()} fallback={<p class={note}>{language.t("mango.home.nothingFits")}</p>}>
              {(model) => (
                <div data-component="mango-recommended" class={card}>
                  <span class="text-[12px] leading-4 text-v2-text-text-faint">
                    {language.t("mango.home.recommended")}
                  </span>
                  <div class="flex flex-col gap-1">
                    <span class="text-[16px] leading-6 text-v2-text-text-base [font-weight:530]">{model().label}</span>
                    <Show when={model().about}>{(about) => <span class={note}>{about()}</span>}</Show>
                  </div>
                  <ModelFacts model={model()} />
                  <div class="flex flex-col items-start gap-1">
                    <BridgeButton
                      action="mango-start"
                      label={language.t("mango.home.start", { size: formatFileSize(model().bytes, language.intl()) })}
                      disabled={busy()}
                      onClick={() => void download([model().key])}
                    />
                    {/* from the phone nothing is downloaded: the note about the download would promise what is not there */}
                    <Show when={mango.bridge()?.models}>
                      <span class="text-[12px] leading-4 text-v2-text-text-faint">
                        {model().verdict.where?.placement === "cpu"
                          ? language.t("mango.home.otherPcHint")
                          : language.t("mango.home.startNote")}
                      </span>
                    </Show>
                  </div>
                </div>
              )}
            </Show>
            <Show when={error()}>{(message) => <p class={danger}>{message()}</p>}</Show>
            <div class="flex flex-col gap-2">
              <button type="button" data-action="mango-choose" class={row} onClick={() => setChoosing(true)}>
                <span class="text-[14px] leading-5 text-v2-text-text-base">{language.t("mango.home.choose")}</span>
                <span class={note}>{language.t("mango.home.choose.note")}</span>
              </button>
              <OtherPc />
              <Show when={mango.bridge()?.models}>
                <button type="button" data-action="mango-own-file" class={row} onClick={mango.openOtherModel}>
                  <span class="text-[14px] leading-5 text-v2-text-text-base">{language.t("mango.home.ownFile")}</span>
                  <span class={note}>{language.t("mango.home.ownFile.note")}</span>
                </button>
              </Show>
            </div>
          </>
        }
      >
        <div class="flex flex-col gap-1">
          <h2 class={title}>{language.t("mango.home.choose.title")}</h2>
          <p class={note}>{language.t("mango.home.choose.body")}</p>
        </div>
        <Show when={!mango.bridge()?.models}>
          <PcOnly />
        </Show>
        {/* a box reached with Tab stops above the buttons fixed at the bottom, not behind them */}
        <div data-component="mango-choose-list" class="flex flex-col gap-1 [&_input]:scroll-mb-28">
          <For each={catalog()}>
            {(model) => (
              <label
                data-option-key={model.key}
                class="flex items-start gap-3 rounded-md px-3 py-2"
                classList={{
                  "opacity-60": !model.verdict.fits,
                  "hover:bg-v2-overlay-simple-overlay-hover": model.verdict.fits,
                }}
              >
                <Show when={mango.bridge()?.models}>
                  <input
                    type="checkbox"
                    class="mt-1"
                    disabled={!model.verdict.fits}
                    checked={chosen().includes(model.key)}
                    onChange={(event) =>
                      setChosen((keys) =>
                        event.currentTarget.checked ? [...keys, model.key] : keys.filter((key) => key !== model.key),
                      )
                    }
                  />
                </Show>
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="flex items-center gap-2 text-[14px] leading-5 text-v2-text-text-base">
                    {model.label}
                    <Show when={model.recommended}>
                      <span class="text-[12px] text-v2-text-text-muted">{language.t("mango.home.recommendedTag")}</span>
                    </Show>
                  </span>
                  <Show when={model.about}>{(about) => <span class={note}>{about()}</span>}</Show>
                  <span class="text-[12px] leading-4 text-v2-text-text-faint">
                    {model.verdict.fits && model.verdict.where
                      ? `${cardsText(model.verdict.where, language)} · ${contextLabel(model.verdict.where.context)} · ${formatFileSize(model.bytes, language.intl())}`
                      : model.verdict.reason}
                  </span>
                </span>
              </label>
            )}
          </For>
        </div>
        {/* another model, from Hugging Face or a file, is added in the settings: only from the computer */}
        <Show when={mango.bridge()?.models}>
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 [&>*]:scroll-mb-28">
            <button
              type="button"
              data-action="mango-search-hf"
              class="text-left text-[14px] leading-5 text-v2-text-text-muted"
              onClick={mango.openOtherModel}
            >
              {language.t("mango.home.searchHf")}
            </button>
            <ButtonV2 variant="ghost" data-action="mango-pick-file" onClick={mango.openOtherModel}>
              {language.t("mango.home.pickFile")}
            </ButtonV2>
          </div>
        </Show>
        {/* always in view at the bottom, the list scrolling above them, with the refusal of the download:
            in the flow above, a list longer than the window would hide it */}
        <div
          data-slot="mango-choose-actions"
          class="sticky bottom-0 z-10 -mb-16 flex flex-col gap-2 bg-v2-background-bg-base pt-3 pb-6"
        >
          <Show when={error()}>{(message) => <p class={danger}>{message()}</p>}</Show>
          <div class="flex items-center gap-2">
            <ButtonV2 variant="ghost" data-action="mango-choose-back" onClick={() => setChoosing(false)}>
              {language.t("mango.home.back")}
            </ButtonV2>
            <Show when={mango.bridge()?.models}>
              <ButtonV2
                data-action="mango-start-chosen"
                disabled={busy() || chosen().length === 0}
                onClick={() => void download(chosen())}
              >
                {startLabel()}
              </ButtonV2>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}

/** Where the model runs, how much conversation it remembers, how fast. */
function ModelFacts(props: { model: CatalogEntry }) {
  const language = useLanguage()
  const where = () => props.model.verdict.where
  // on the cards a model is quick; on the processor the verdict says how much
  const speed = () => (where()?.placement === "gpu" ? "quick" : props.model.verdict.speed)
  return (
    <Show when={where()}>
      {(place) => (
        <div class="flex flex-wrap gap-x-3 text-[13px] leading-5 text-v2-text-text-muted">
          <span>
            {place().placement === "gpu" && place().gpus.length > 0
              ? language.t("mango.home.onCards", { cards: cardsText(place(), language) })
              : language.t("mango.home.onCpu")}
          </span>
          <span>
            {language.t("mango.home.context", {
              context: contextLabel(place().context),
              words: contextWords(place().context),
            })}
          </span>
          <Show when={speed()}>
            {(value) => <span data-slot="mango-speed">{language.t(`mango.speed.${value()}`)}</span>}
          </Show>
        </div>
      )}
    </Show>
  )
}

function Found() {
  const mango = useMango()
  const language = useLanguage()
  const gb = (mib: number) => formatFileSize(mib * 1024 * 1024, language.intl())
  return (
    <Show when={mango.computer()}>
      {(computer) => (
        <div data-component="mango-found" class={card}>
          <span class="text-[12px] leading-4 text-v2-text-text-faint">{language.t("mango.home.found")}</span>
          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px] leading-5">
            <Show when={computer().gpus.length > 0}>
              <dt class="text-v2-text-text-muted">{language.t("mango.home.gpus")}</dt>
              <dd class="flex flex-col text-v2-text-text-base">
                <For each={computer().gpus}>
                  {(gpu) => (
                    <span>
                      {language.t("mango.home.gpu", { name: gpu.name, size: gb(gpu.memory_mib) })}
                      <Show when={!gpu.used || gpu.note}>
                        <span class="block text-v2-text-text-faint">
                          {gpu.note || language.t("mango.home.gpu.unused")}
                        </span>
                      </Show>
                    </span>
                  )}
                </For>
              </dd>
            </Show>
            <dt class="text-v2-text-text-muted">{language.t("mango.home.cpu")}</dt>
            <dd class="text-v2-text-text-base">
              {language.t("mango.home.cpu.cores", { cpu: computer().cpu, cores: computer().cores })}
            </dd>
            <dt class="text-v2-text-text-muted">{language.t("mango.home.ram")}</dt>
            <dd class="text-v2-text-text-base">{gb(computer().ram_mib)}</dd>
            <dt class="text-v2-text-text-muted">{language.t("mango.home.disk")}</dt>
            <dd class="text-v2-text-text-base">
              {language.t("mango.home.disk.free", {
                size: formatFileSize(computer().disk.free_bytes, language.intl()),
                path: diskDrive(computer().disk.path),
              })}
            </dd>
          </dl>
        </div>
      )}
    </Show>
  )
}

/** «Use the engine of another PC of mine»: the code it gives, pasted here; the app starts again on its engine. */
function OtherPc() {
  const mango = useMango()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const [code, setCode] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const connect = async () => {
    const remote = mango.bridge()?.engineRemote
    if (!remote || !code().trim()) return
    setBusy(true)
    setError(undefined)
    try {
      await remote.connect(code().trim())
    } catch (cause) {
      setError(mangoDesktopError(cause).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Show when={mango.bridge()?.engineRemote}>
      <div class="flex flex-col gap-2">
        <button
          type="button"
          data-action="mango-other-pc"
          class={row}
          aria-expanded={open()}
          onClick={() => setOpen((value) => !value)}
        >
          <span class="text-[14px] leading-5 text-v2-text-text-base">{language.t("mango.home.remote")}</span>
          <span class={note}>{language.t("mango.home.remote.note")}</span>
        </button>
        <Show when={open()}>
          <div class="flex items-center gap-2 px-3">
            <TextInputV2
              class="min-w-0 flex-1"
              value={code()}
              aria-label={language.t("mango.home.remote.placeholder")}
              placeholder={language.t("mango.home.remote.placeholder")}
              onInput={(event) => setCode(event.currentTarget.value)}
            />
            <ButtonV2
              data-action="mango-other-pc-connect"
              disabled={busy() || !code().trim()}
              onClick={() => void connect()}
            >
              {language.t("mango.home.remote.connect")}
            </ButtonV2>
          </div>
          <Show when={error()}>{(message) => <p class={`px-3 ${danger}`}>{message()}</p>}</Show>
        </Show>
      </div>
    </Show>
  )
}

function Downloading(props: Actions) {
  const mango = useMango()
  const language = useLanguage()
  const theme = useTheme()
  const schemes = ["system", "light", "dark"] as const
  const download = () => {
    const state = mango.state()
    return state && mainDownload(state)
  }
  return (
    <div data-component="mango-downloading" class={panel}>
      <Show when={download()}>{(current) => <DownloadCard download={current()} />}</Show>
      <DictationRow />
      <div class="flex items-center justify-between gap-3 px-1">
        <span class="text-[14px] leading-5 text-v2-text-text-base">{language.t("mango.home.theme")}</span>
        <SelectV2
          appearance="inline"
          data-action="mango-home-theme"
          aria-label={language.t("mango.home.theme")}
          options={[...schemes]}
          current={schemes.find((scheme) => scheme === theme.colorScheme())}
          placement="bottom-end"
          gutter={6}
          label={(scheme) => language.t(`theme.scheme.${scheme}`)}
          onSelect={(scheme) => scheme && theme.setColorScheme(scheme)}
        />
      </div>
      <div>
        <ButtonV2 variant="ghost" data-action="mango-change-model" onClick={mango.openModels}>
          {language.t("mango.home.changeModel")}
        </ButtonV2>
      </div>
      <div class={card}>
        <div class="flex flex-col gap-1">
          <span class="text-[14px] leading-5 text-v2-text-text-base [font-weight:530]">
            {language.t("mango.home.firstProject")}
          </span>
          <span class={note}>{language.t("mango.home.firstProject.note")}</span>
        </div>
        <div class="flex flex-wrap gap-2">
          <Show when={props.onNewProject}>
            {(create) => (
              <ButtonV2 data-action="mango-new-project" onClick={create()}>
                {language.t("project.create.action")}
              </ButtonV2>
            )}
          </Show>
          <ButtonV2 variant="ghost" data-action="mango-open-folder" onClick={props.onOpenFolder}>
            {language.t("home.project.add")}
          </ButtonV2>
        </div>
      </div>
    </div>
  )
}

/**
 * A download as the Home shows it: what it brings, how far it is, and Resume or Retry when it stands still. The first
 * model's, or the engine the app came with («Aggiorno il motore»).
 */
function DownloadCard(props: { download: Download }) {
  const mango = useMango()
  const language = useLanguage()
  const [error, setError] = createSignal<string>()
  const act = async (
    action: (models: NonNullable<NonNullable<ReturnType<typeof mango.bridge>>["models"]>) => Promise<void>,
  ) => {
    const models = mango.bridge()?.models
    if (!models) return
    setError(undefined)
    try {
      await action(models)
      await mango.refresh()
    } catch (cause) {
      setError(mangoDesktopError(cause).message)
    }
  }
  const queued = () => {
    const state = mango.state()
    return state && queueText(state, props.download, language)
  }
  const progress = () => {
    const parts = downloadParts(props.download, language)
    return [parts.amount, parts.speed, parts.eta].filter(Boolean).join(" · ")
  }
  return (
    <div
      class={card}
      data-component="mango-download"
      data-state={props.download.state}
      data-engine={props.download.engine_only ? "" : undefined}
    >
      <h2 class="text-[16px] leading-6 text-v2-text-text-base [font-weight:530]">
        <Switch fallback={downloadTitle(props.download, language)}>
          <Match when={props.download.state === "paused"}>{downloadPausedText(props.download, language)}</Match>
          <Match when={props.download.state === "failed"}>{downloadFailedText(props.download, language)}</Match>
        </Switch>
      </h2>
      <div
        role="progressbar"
        aria-label={downloadTitle(props.download, language)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={downloadPercent(props.download)}
        class="h-1.5 overflow-hidden rounded-full bg-v2-background-bg-base"
      >
        <div
          class="h-full rounded-full bg-v2-text-text-base transition-[width]"
          style={{ width: `${downloadPercent(props.download)}%` }}
        />
      </div>
      <p class={note}>
        {progress()}. {language.t("mango.home.downloading.resume")}
      </p>
      <Show when={queued()}>
        {(text) => (
          <p data-slot="mango-download-queue" class={note}>
            {text()}
          </p>
        )}
      </Show>
      <Show when={props.download.state === "failed" || props.download.state === "paused"}>
        <div class="flex items-center gap-2">
          <Show when={mango.bridge()?.models} fallback={<PcOnly />}>
            <Show
              when={props.download.state === "failed"}
              fallback={
                <ButtonV2
                  data-action="mango-download-resume"
                  onClick={() => void act((models) => models.resume(props.download.model))}
                >
                  {language.t("mango.home.downloading.resumeAction")}
                </ButtonV2>
              }
            >
              <ButtonV2
                data-action="mango-download-retry"
                onClick={() => void act((models) => models.download([props.download.model]))}
              >
                {language.t("mango.action.retry")}
              </ButtonV2>
            </Show>
          </Show>
        </div>
      </Show>
      <Show when={error()}>{(message) => <p class={danger}>{message()}</p>}</Show>
    </div>
  )
}

/**
 * The default model did not start: why, the model that fits now (only this time), retry, the settings, and under it
 * the manager's own sentence («Technical details», when another program is the cause) and the report, which opens Help
 * in the settings: there the user adds a note before sending.
 */
function FailedStart() {
  const mango = useMango()
  const language = useLanguage()
  const [error, setError] = createSignal<string>()
  const [details, setDetails] = createSignal(false)
  const failed = () => {
    const model = mango.state()?.model
    return model?.phase === "failed" ? model : undefined
  }
  const act = (action: () => Promise<void>) => {
    setError(undefined)
    void action().catch((cause: unknown) => setError(failureText(cause, language.t)))
  }
  const line = "flex items-center justify-between gap-4 border-t border-v2-border-border-muted pt-3"
  return (
    <Show when={failed()}>
      {(model) => (
        <div data-component="mango-failed" class={`${card} ${above}`}>
          <div class="flex flex-col gap-1">
            <h2 class="text-[16px] leading-6 text-v2-text-text-base [font-weight:530]">
              {language.t("mango.failed.title", { model: model().label })}
            </h2>
            <Show when={model().taken ?? model().reason}>{(text) => <p class={note}>{text()}</p>}</Show>
          </div>
          <Show when={model().proposal}>
            {(proposal) => (
              <div class={line}>
                <div class="flex flex-col">
                  <span class="text-[14px] leading-5 text-v2-text-text-base">
                    {language.t("mango.action.useProposal", { model: proposal().label })}
                  </span>
                  <span class={note}>
                    {language.t("mango.failed.proposal.note", { fits: fitsText(proposal().where, language) })}
                  </span>
                </div>
                <ButtonV2
                  data-action="mango-failed-proposal"
                  onClick={() => act(() => mango.use(proposal().model, true))}
                >
                  {language.t("mango.failed.start")}
                </ButtonV2>
              </div>
            )}
          </Show>
          <div class={line}>
            <div class="flex flex-col">
              <span class="text-[14px] leading-5 text-v2-text-text-base">{language.t("mango.action.retry")}</span>
              <Show when={model().taken}>
                <span class={note}>{language.t("mango.failed.retry.note")}</span>
              </Show>
            </div>
            <ButtonV2 variant="ghost" data-action="mango-failed-retry" onClick={() => act(() => mango.retry())}>
              {language.t("mango.action.retry")}
            </ButtonV2>
          </div>
          <div class={line}>
            <div class="flex flex-col">
              <span class="text-[14px] leading-5 text-v2-text-text-base">{language.t("mango.failed.settings")}</span>
              <span class={note}>{language.t("mango.failed.settings.note")}</span>
            </div>
            <ButtonV2
              variant="ghost"
              data-action="mango-failed-settings"
              onClick={() => mango.openModelRow(model().model)}
            >
              {language.t("mango.failed.open")}
            </ButtonV2>
          </div>
          <Show when={error()}>{(message) => <p class={danger}>{message()}</p>}</Show>
          <div class="flex flex-wrap items-center gap-2">
            <Show when={model().taken && model().reason}>
              <ButtonV2
                variant="ghost"
                size="small"
                data-action="mango-failed-details"
                aria-expanded={details()}
                onClick={() => setDetails((value) => !value)}
              >
                {language.t("mango.failed.details")}
              </ButtonV2>
            </Show>
            <ButtonV2 variant="ghost" size="small" data-action="mango-failed-report" onClick={mango.openHelp}>
              {language.t("mango.failed.report")}
            </ButtonV2>
          </div>
          <Show when={details()}>
            <pre
              data-slot="mango-failed-details"
              class="whitespace-pre-wrap break-words text-[12px] leading-4 text-v2-text-text-muted"
            >
              {model().reason}
            </pre>
          </Show>
        </div>
      )}
    </Show>
  )
}

/** The other PC's engine does not answer: the way back to this PC's engine (the app starts again on it). */
function RemoteDown() {
  const mango = useMango()
  const language = useLanguage()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const back = async () => {
    const remote = mango.bridge()?.engineRemote
    if (!remote) return
    setBusy(true)
    setError(undefined)
    try {
      await remote.disconnect()
    } catch (cause) {
      setError(`${language.t("mango.remote.failed")}: ${mangoDesktopError(cause).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-component="mango-remote-down" class={panel}>
      <div class={card}>
        <h2 class="text-[16px] leading-6 text-v2-text-text-base [font-weight:530]">
          {language.t("mango.remote.title")}
        </h2>
        <p class={note}>{language.t("mango.remote.body")}</p>
        <div>
          <Show when={mango.bridge()?.engineRemote} fallback={<PcOnly />}>
            <ButtonV2 data-action="mango-remote-back" disabled={busy()} onClick={() => void back()}>
              {language.t("mango.remote.back")}
            </ButtonV2>
          </Show>
        </div>
        <Show when={error()}>{(message) => <p class={danger}>{message()}</p>}</Show>
      </div>
    </div>
  )
}

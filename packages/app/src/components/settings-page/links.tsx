// mango-code: Settings › Connections: everything that leaves this PC or comes into it,
// with the keys in one place, off by default. One card each: the phone, lending the engine to the user's other PCs, the
// engine of another PC, the cloud (OpenRouter and the Team) and Hugging Face. A card opens below itself what it needs (the
// QR, the codes, the field for a code or a key). Everything goes through the bridge, which only the app's window has:
// elsewhere (the phone, a browser) the cards say how things are and «si fa dal computer».
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, createResource, createSignal, For, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { remoteEngine } from "./lines"
import type { MangoEngineShareState, MangoPhoneState } from "@/utils/mango-desktop"
import { PhoneAccess } from "../settings-v2/phone"
import { SettingsTeamV2 } from "../settings-v2/team"
import { createCommands, useControl } from "./control"

type CardId = "phone" | "share" | "remote" | "cloud" | "token"

export const SettingsLinks: Component = () => {
  const language = useLanguage()
  const [open, setOpen] = createSignal<CardId>()
  const toggle = (id: CardId) => setOpen((current) => (current === id ? undefined : id))
  const card = (id: CardId) => ({ open: open() === id, onOpen: () => toggle(id) })
  return (
    <div class="settings-v2-tab-body" data-component="settings-links">
      <p class="settings-page-note">{language.t("settings.links.lead")}</p>
      <Show when={!window.__MANGO_DESKTOP__}>
        <p class="settings-page-note" data-slot="settings-pc-only">
          {language.t("settings.pcOnly")}
        </p>
      </Show>
      <div class="settings-page-card-grid">
        <PhoneCard {...card("phone")} />
        <ShareCard {...card("share")} />
        <RemoteCard {...card("remote")} />
        <CloudCard {...card("cloud")} />
        <TokenCard {...card("token")} />
      </div>
    </div>
  )
}

type CardProps = { open: boolean; onOpen: () => void }

/**
 * A card: title (with its switch, if it has one), a line, and at the foot how it is and what can be done. `pill`: how it
 * is; without the bridge the page cannot read it, and the foot says nothing rather than «off» or «no key».
 */
const LinkCard: Component<{
  id: CardId
  title: string
  line: string
  open: boolean
  switch?: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }
  pill?: { text: string; tone?: "ok" | "bad" }
  action?: { label: string; disabled: boolean; onClick: () => void }
  error?: string
  children?: JSX.Element
}> = (props) => (
  <div class="settings-page-link-card" data-link-card={props.id} data-open={props.open ? "" : undefined}>
    <div class="settings-page-link-card-head">
      <span data-slot="settings-v2-row-title">{props.title}</span>
      <Show when={props.switch}>
        {(control) => (
          <span data-action={`settings-${props.id}-switch`}>
            <Switch
              checked={control().checked}
              disabled={control().disabled}
              onChange={control().onChange}
              aria-label={props.title}
            />
          </span>
        )}
      </Show>
    </div>
    <p class="settings-page-row-line">{props.line}</p>
    <div class="settings-page-link-card-foot">
      <Show when={props.pill}>
        {(pill) => (
          <span class="settings-page-pill" data-tone={pill().tone}>
            {pill().text}
          </span>
        )}
      </Show>
      <Show when={props.action}>
        {(action) => (
          <ButtonV2
            variant="ghost"
            class="ml-auto"
            disabled={action().disabled}
            onClick={action().onClick}
            data-action={`settings-${props.id}-open`}
          >
            {action().label}
          </ButtonV2>
        )}
      </Show>
    </div>
    <Show when={props.error}>{(message) => <p class="settings-page-error">{message()}</p>}</Show>
    <Show when={props.open && props.children}>
      <div class="settings-page-link-card-detail">{props.children}</div>
    </Show>
  </div>
)

/** The two places of the phone and of the lent engine: the home network and away (Tailscale). */
function places<T>(state: { home: T | null; away: T | null } | undefined, t: ReturnType<typeof useLanguage>["t"]) {
  return [
    { label: t("settings.phone.home"), access: state?.home ?? null, missing: t("settings.phone.home.missing") },
    { label: t("settings.phone.away"), access: state?.away ?? null, missing: t("settings.phone.away.missing") },
  ]
}

const PhoneCard: Component<CardProps> = (props) => {
  const language = useLanguage()
  const phone = () => window.__MANGO_DESKTOP__?.phone
  const commands = createCommands()
  // a read that is refused says why in the card, like a command
  const [state, { mutate }] = createResource(
    async () => (await commands.run("phone", () => phone()?.state())) ?? undefined,
  )
  const change = async (action: () => Promise<MangoPhoneState> | undefined) => {
    const next = await commands.run("phone", action)
    if (next) mutate(next)
  }
  return (
    <LinkCard
      id="phone"
      title={language.t("settings.links.phone.title")}
      line={language.t("settings.links.phone.line")}
      open={props.open && !!state()?.enabled}
      switch={{
        checked: state()?.enabled ?? false,
        disabled: !state() || commands.busy("phone"),
        onChange: (checked) => void change(() => phone()?.setEnabled(checked)),
      }}
      pill={
        phone()
          ? state()?.enabled
            ? { text: language.t("settings.links.on"), tone: "ok" }
            : { text: language.t("settings.links.off") }
          : undefined
      }
      action={{
        label: language.t(props.open ? "settings.links.close" : "settings.links.phone.show"),
        disabled: !state()?.enabled,
        onClick: props.onOpen,
      }}
      error={commands.error("phone") ?? state()?.error ?? undefined}
    >
      <div class="flex flex-wrap gap-6">
        <For each={places(state(), language.t)}>
          {(place) => <PhoneAccess label={place.label} access={place.access} missing={place.missing} />}
        </For>
      </div>
      <p class="settings-page-row-line">{language.t("settings.phone.firewall")}</p>
      <div>
        <ButtonV2
          variant="neutral"
          disabled={commands.busy("phone")}
          onClick={() => void change(() => phone()?.newKey())}
          data-action="settings-phone-new-key"
        >
          {language.t("settings.phone.newKey")}
        </ButtonV2>
      </div>
    </LinkCard>
  )
}

const ShareCard: Component<CardProps> = (props) => {
  const language = useLanguage()
  const share = () => window.__MANGO_DESKTOP__?.engineShare
  const commands = createCommands()
  const [state, { mutate }] = createResource(
    async () => (await commands.run("share", () => share()?.state())) ?? undefined,
  )
  const change = async (action: () => Promise<MangoEngineShareState> | undefined) => {
    const next = await commands.run("share", action)
    if (next) mutate(next)
  }
  return (
    <LinkCard
      id="share"
      title={language.t("settings.links.share.title")}
      line={language.t("settings.links.share.line")}
      open={props.open && !!state()?.enabled}
      switch={{
        checked: state()?.enabled ?? false,
        disabled: !state() || commands.busy("share"),
        onChange: (checked) => void change(() => share()?.setEnabled(checked)),
      }}
      pill={
        share()
          ? state()?.enabled
            ? { text: language.t("settings.links.on"), tone: "ok" }
            : { text: language.t("settings.links.off") }
          : undefined
      }
      action={{
        label: language.t(props.open ? "settings.links.close" : "settings.links.share.copy"),
        disabled: !state()?.enabled,
        onClick: props.onOpen,
      }}
      error={commands.error("share") ?? state()?.error ?? undefined}
    >
      <p class="settings-page-row-line">{language.t("settings.links.share.description")}</p>
      <div class="flex flex-wrap gap-6">
        <For each={places(state(), language.t)}>
          {(place) => <ShareAccess label={place.label} access={place.access} missing={place.missing} />}
        </For>
      </div>
      <p class="settings-page-row-line">{language.t("settings.links.share.where")}</p>
      <p class="settings-page-row-line">{language.t("settings.links.share.firewall")}</p>
      <div>
        <ButtonV2
          variant="neutral"
          disabled={commands.busy("share")}
          onClick={() => void change(() => share()?.newKey())}
          data-action="settings-share-new-key"
        >
          {language.t("settings.phone.newKey")}
        </ButtonV2>
      </div>
    </LinkCard>
  )
}

/** One place of the shared engine and its code to copy: the code stays here, it is copied, never shown. */
const ShareAccess: Component<{ label: string; access: MangoEngineShareState["home"]; missing: string }> = (props) => {
  const language = useLanguage()
  const [copied, setCopied] = createSignal(false)
  return (
    <div class="flex w-[220px] flex-col gap-2" data-slot="settings-share-access">
      <div class="text-[13px] font-medium text-text-strong">{props.label}</div>
      <Show when={props.access} fallback={<p class="settings-page-row-line">{props.missing}</p>}>
        {(access) => (
          <>
            <div>
              <ButtonV2
                variant="neutral"
                onClick={() =>
                  void navigator.clipboard.writeText(access().code).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  )
                }
                data-action="settings-share-copy"
              >
                {language.t(copied() ? "settings.phone.copied" : "settings.links.share.copy")}
              </ButtonV2>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

const RemoteCard: Component<CardProps> = (props) => {
  const language = useLanguage()
  const control = useControl()
  const remote = () => window.__MANGO_DESKTOP__?.engineRemote
  // the engine in use, from the agent's state: another PC's when the model phase says «remote»
  const using = () => remoteEngine(control.view.state)
  const [code, setCode] = createSignal("")
  const [status, setStatus] = createSignal<string>()
  const commands = createCommands()

  const connect = async () => {
    if (!code().trim()) return setStatus(language.t("settings.links.remote.paste"))
    setStatus(language.t("settings.links.remote.checking"))
    const done = await commands.run("remote", async () => {
      await remote()?.connect(code())
      return true
    })
    // the app starts again on that engine: the window reloads by itself
    setStatus(done ? language.t("settings.links.remote.switching") : undefined)
    if (done) setCode("")
  }

  return (
    <LinkCard
      id="remote"
      title={language.t("settings.links.remote.title")}
      line={language.t("settings.links.remote.line")}
      open={props.open}
      pill={
        using()
          ? { text: language.t("settings.links.remote.using"), tone: "ok" }
          : { text: language.t("settings.links.remote.none") }
      }
      action={{
        label: language.t(
          props.open
            ? "settings.links.close"
            : using()
              ? "settings.links.remote.manage"
              : "settings.links.remote.connect",
        ),
        disabled: false,
        onClick: props.onOpen,
      }}
      error={commands.error("remote")}
    >
      <Show
        when={using()}
        fallback={
          <>
            <p class="settings-page-row-line">{language.t("settings.links.remote.intro")}</p>
            <form
              class="flex flex-wrap items-center gap-2"
              data-action="settings-remote-form"
              onSubmit={(event) => {
                event.preventDefault()
                void connect()
              }}
            >
              {/* the key is in the code: the field hides it like a password */}
              <TextInputV2
                type="password"
                appearance="base"
                value={code()}
                onInput={(event) => setCode(event.currentTarget.value)}
                placeholder={language.t("settings.links.remote.placeholder")}
                aria-label={language.t("settings.links.remote.placeholder")}
                disabled={!remote() || commands.busy("remote")}
                autocomplete="off"
              />
              <ButtonV2 type="submit" variant="contrast" disabled={!remote() || commands.busy("remote")}>
                {language.t("settings.links.remote.go")}
              </ButtonV2>
            </form>
            <Show when={status()}>
              {(text) => (
                <p class="settings-page-row-line" data-slot="settings-remote-status">
                  {text()}
                </p>
              )}
            </Show>
          </>
        }
      >
        {(engine) => (
          <>
            <p class="settings-page-row-line">{language.t("settings.links.remote.usingLine")}</p>
            <p class="settings-page-row-line">
              {language.t("settings.links.remote.models", { names: engine().models.join(", ") })}
            </p>
            <div>
              <ButtonV2
                variant="neutral"
                disabled={!remote() || commands.busy("remote")}
                onClick={() => void commands.run("remote", () => remote()?.disconnect())}
                data-action="settings-remote-back"
              >
                {language.t("settings.links.remote.back")}
              </ButtonV2>
            </div>
          </>
        )}
      </Show>
    </LinkCard>
  )
}

const CloudCard: Component<CardProps> = (props) => {
  const language = useLanguage()
  const team = () => window.__MANGO_DESKTOP__?.team
  const commands = createCommands()
  const [info, { refetch }] = createResource(
    async () => (await commands.run("cloud", () => team()?.info())) ?? undefined,
  )
  return (
    <LinkCard
      id="cloud"
      title={language.t("settings.links.cloud.title")}
      line={language.t("settings.links.cloud.line")}
      open={props.open && !!team()}
      pill={
        team()
          ? info()?.key
            ? { text: language.t("settings.links.cloud.key"), tone: "ok" }
            : { text: language.t("settings.links.cloud.noKey") }
          : undefined
      }
      action={{
        label: language.t(
          props.open
            ? "settings.links.close"
            : info()?.key
              ? "settings.links.cloud.manage"
              : "settings.links.cloud.add",
        ),
        disabled: !team(),
        onClick: props.onOpen,
      }}
      error={commands.error("cloud")}
    >
      <SettingsTeamV2 onChange={() => void refetch()} />
    </LinkCard>
  )
}

const TokenCard: Component<CardProps> = (props) => {
  const language = useLanguage()
  const token = () => window.__MANGO_DESKTOP__?.token
  const commands = createCommands()
  const [saved, { refetch }] = createResource(
    async () => (await commands.run("token", () => token()?.status())) ?? false,
  )
  const [value, setValue] = createSignal("")

  // the pill says the result; read again only after a change: a read clears the sentence of a refusal
  const work = async (job: () => Promise<void> | undefined) => {
    const ok = await commands.run("token", async () => {
      await job()
      return true
    })
    if (!ok) return
    setValue("")
    void refetch()
  }

  return (
    <LinkCard
      id="token"
      title={language.t("settings.token.title")}
      line={language.t("settings.token.description")}
      open={props.open && !!token() && !saved()}
      pill={
        token()
          ? saved()
            ? { text: language.t("settings.token.savedPill"), tone: "ok" }
            : { text: language.t("settings.token.none") }
          : undefined
      }
      // saved, the foot removes it; to change it, it is removed and added again
      action={
        saved()
          ? {
              label: language.t("settings.token.remove"),
              disabled: !token() || commands.busy("token"),
              onClick: () => void work(() => token()?.remove()),
            }
          : {
              label: language.t(props.open ? "settings.links.close" : "settings.token.add"),
              disabled: !token(),
              onClick: props.onOpen,
            }
      }
      error={commands.error("token")}
    >
      <form
        class="flex flex-wrap items-center gap-2"
        data-action="settings-token"
        onSubmit={(event) => {
          event.preventDefault()
          void work(() => token()?.save(value()))
        }}
      >
        <TextInputV2
          type="password"
          appearance="base"
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
          placeholder="hf_…"
          aria-label={language.t("settings.token.title")}
          disabled={commands.busy("token")}
          autocomplete="new-password"
        />
        <ButtonV2 type="submit" variant="contrast" disabled={commands.busy("token") || !value().trim()}>
          {language.t("settings.token.save")}
        </ButtonV2>
      </form>
    </LinkCard>
  )
}

// mango-code: Settings › Connections: everything that leaves this PC or comes into it,
// with the keys in one place, off by default. One card each: the phone, lending the engine to the user's other PCs, the
// engine of another PC, the external servers, the cloud (OpenRouter and the Team) and Hugging Face. A card opens below itself what it needs (the
// QR, the codes, the field for a code or a key). Everything goes through the bridge, which only the app's window has:
// elsewhere (the phone, a browser) the cards say how things are and «si fa dal computer».
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, createResource, createSignal, For, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { remoteEngine } from "./lines"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import type { MangoEngineShareState, MangoPhoneState } from "@/utils/mango-desktop"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useMango } from "@/context/mango"
import { ServerModelList } from "../server-model-list"
import { RemoveServerDialog } from "./remove-server"
import { PhoneAccess } from "../settings-v2/phone"
import { SettingsTeamV2 } from "../settings-v2/team"
import { createCommands, useControl } from "./control"
import { PaneHeader } from "./header"

type CardId = "phone" | "share" | "remote" | "servers" | "cloud" | "token"

export const SettingsLinks: Component = () => {
  const language = useLanguage()
  const [open, setOpen] = createSignal<CardId>()
  const toggle = (id: CardId) => setOpen((current) => (current === id ? undefined : id))
  const card = (id: CardId) => ({ open: open() === id, onOpen: () => toggle(id) })
  return (
    <div class="settings-v2-tab-body" data-component="settings-links">
      <PaneHeader title={language.t("settings.section.links")} lead={language.t("settings.links.lead")} />
      <Show when={!window.__MANGO_DESKTOP__}>
        <p class="settings-page-note" data-slot="settings-pc-only">
          {language.t("settings.pcOnly")}
        </p>
      </Show>
      <div class="settings-page-box">
        <PhoneCard {...card("phone")} />
        <ShareCard {...card("share")} />
        <RemoteCard {...card("remote")} />
        <ServersCard {...card("servers")} />
        <CloudCard {...card("cloud")} />
        <TokenCard {...card("token")} />
      </div>
    </div>
  )
}

type CardProps = { open: boolean; onOpen: () => void }

/**
 * A row of the card: the title with how it is, a line under it, and on the right what can be done and its switch, if it
 * has one; what it needs opens below. `pill`: how it is; without the bridge the page cannot read it, and the row says
 * nothing rather than «off» or «no key».
 */
const LinkCard: Component<{
  id: CardId
  title: string
  line: string
  open: boolean
  switch?: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }
  pill?: { text: string; tone?: "ready" | "error" }
  action?: { label: string; disabled: boolean; onClick: () => void; destructive?: boolean }
  error?: string
  children?: JSX.Element
}> = (props) => (
  <div class="settings-page-link-card" data-link-card={props.id} data-open={props.open ? "" : undefined}>
    <div class="settings-page-row">
      <div class="settings-page-row-copy">
        <span class="settings-page-row-heading">
          <span data-slot="settings-v2-row-title">{props.title}</span>
          <Show when={props.pill}>{(pill) => <Tag variant={pill().tone}>{pill().text}</Tag>}</Show>
        </span>
        <span class="settings-page-row-line">{props.line}</span>
      </div>
      <div class="settings-page-row-meta">
        <Show when={props.action}>
          {(action) => (
            <ButtonV2
              variant={action().destructive ? "danger" : "ghost"}
              disabled={action().disabled}
              onClick={action().onClick}
              data-action={`settings-${props.id}-open`}
            >
              {action().label}
            </ButtonV2>
          )}
        </Show>
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
    </div>
    <Show when={props.error}>{(message) => <p class="settings-page-error settings-page-row-note">{message()}</p>}</Show>
    <Show when={props.open && props.children}>
      <div class="settings-page-link-card-detail">{props.children}</div>
    </Show>
  </div>
)

/** Under this context a model of a server has little room left once Mango Code's instructions and tools are in. */
const SMALL_SERVER_CONTEXT = 32_768
/** A server with this many models or fewer says their names on its card; with more, how many. */
const MODEL_NAMES_SHOWN = 3
/** A server with more models than this gets a search above the list of its models. */
const SEARCH_FROM = 8

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
      line={language.t(state()?.enabled ? "settings.links.phone.line" : "settings.links.phone.lineOff")}
      open={props.open && !!state()?.enabled}
      switch={{
        checked: state()?.enabled ?? false,
        disabled: !state() || commands.busy("phone"),
        onChange: (checked) => void change(() => phone()?.setEnabled(checked)),
      }}
      pill={
        phone()
          ? state()?.enabled
            ? { text: language.t("settings.links.on"), tone: "ready" }
            : { text: language.t("settings.links.off") }
          : undefined
      }
      action={
        state()?.enabled
          ? { label: language.t(props.open ? "settings.links.close" : "settings.links.phone.show"), disabled: false, onClick: props.onOpen }
          : undefined
      }
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
      line={language.t(state()?.enabled ? "settings.links.share.line" : "settings.links.share.lineOff")}
      open={props.open && !!state()?.enabled}
      switch={{
        checked: state()?.enabled ?? false,
        disabled: !state() || commands.busy("share"),
        onChange: (checked) => void change(() => share()?.setEnabled(checked)),
      }}
      pill={
        share()
          ? state()?.enabled
            ? { text: language.t("settings.links.on"), tone: "ready" }
            : { text: language.t("settings.links.off") }
          : undefined
      }
      action={
        state()?.enabled
          ? { label: language.t(props.open ? "settings.links.close" : "settings.links.share.copy"), disabled: false, onClick: props.onOpen }
          : undefined
      }
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
          ? { text: language.t("settings.links.remote.using"), tone: "ready" }
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
              <ButtonV2 type="submit" variant="neutral" disabled={!remote() || commands.busy("remote")}>
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

/**
 * «Use a server»: each server with its models, the model of new conversations on it, «Refresh the list» and «Remove»; below,
 * the address and the key of a new one. A server that does not say the context of its models gets it from the user,
 * proposed. Adding and removing start the app again: the window reloads by itself.
 */
const ServersCard: Component<CardProps> = (props) => {
  const language = useLanguage()
  const mango = useMango()
  const dialog = useDialog()
  const servers = () => window.__MANGO_DESKTOP__?.servers
  const commands = createCommands()
  const [state, { refetch }] = createResource(async () => (await commands.run("servers", () => servers()?.state())) ?? undefined)
  const [address, setAddress] = createSignal("")
  const [key, setKey] = createSignal("")
  const [context, setContext] = createSignal<number>()
  const [status, setStatus] = createSignal<string>()
  const busy = () => !servers() || commands.busy("servers")

  const add = async () => {
    if (!address().trim()) return setStatus(language.t("settings.links.servers.address"))
    setStatus(language.t("settings.links.servers.checking"))
    const added = await commands.run("servers", () => servers()?.add(address(), key(), context()))
    if (!added) return setStatus(undefined)
    if (added.context !== null) {
      setContext(added.context)
      return setStatus(language.t("settings.links.servers.context"))
    }
    setStatus(language.t("settings.links.servers.added"))
  }
  const work = async (job: () => Promise<void> | undefined) => {
    const ok = await commands.run("servers", async () => {
      await job()
      return true
    })
    if (!ok) return
    void refetch()
    // the bar names the model of new conversations: it learns at once that the choice changed
    void mango.refresh()
  }
  const [picking, setPicking] = createSignal<string>()
  // the default changes only when the user picks a model: every change starts the agent again
  const pick = (server: string | null, model: string | null) => {
    setPicking(undefined)
    void work(() => servers()?.setDefault(server, model))
  }
  const count = () => state()?.list.length ?? 0
  const [notes, setNotes] = createSignal<Record<string, string[]>>({})

  // What the refresh changed is told on the server's card: the default model that is gone and what new conversations use
  // now, the context the models have now.
  const refresh = async (id: string) => {
    const changed = await commands.run("servers", () => servers()?.refresh(id))
    if (!changed) return
    void refetch()
    await mango.refresh()
    const lines: string[] = []
    if (changed.gone) {
      const model = mango.state()?.default_model
      const next = mango.catalog()?.find((m) => m.present && m.key === model)?.label
      lines.push(
        next
          ? language.t("settings.links.servers.gone", { model: changed.gone, next })
          : language.t("settings.links.servers.goneNone", { model: changed.gone }),
      )
    }
    if (changed.context)
      lines.push(
        language.t("settings.links.servers.contextChanged", {
          from: changed.context.from.toLocaleString(language.intl()),
          to: changed.context.to.toLocaleString(language.intl()),
        }),
      )
    setNotes((all) => ({ ...all, [id]: lines }))
  }
  const askRemove = (server: { id: string; label: string; key: boolean }) =>
    dialog.show(() => (
      <RemoveServerDialog
        host={server.label}
        key={server.key}
        onRemove={() => work(() => servers()?.remove(server.id))}
      />
    ))

  return (
    <LinkCard
      id="servers"
      title={language.t("settings.links.servers.title")}
      line={language.t("settings.links.servers.line")}
      open={props.open}
      pill={
        servers()
          ? count()
            ? { text: language.plural("settings.links.servers.count", count()), tone: "ready" }
            : { text: language.t("settings.links.remote.none") }
          : undefined
      }
      action={{
        label: language.t(props.open ? "settings.links.close" : count() ? "settings.links.remote.manage" : "settings.links.servers.add"),
        disabled: !servers(),
        onClick: props.onOpen,
      }}
      error={commands.error("servers")}
    >
      <For each={state()?.list ?? []}>
        {(server) => {
          const chosen = () => {
            const d = state()?.default
            return d?.server === server.id ? server.models.find((m) => m.id === d.model) : undefined
          }
          const offered = () =>
            server.models.length <= MODEL_NAMES_SHOWN
              ? server.models.map((m) => m.label).join(", ")
              : language.plural("settings.links.servers.models", server.models.length)
          // the model the user uses on this server: the default one, or the only one
          const used = () => chosen() ?? (server.models.length === 1 ? server.models[0] : undefined)
          const small = () => {
            const model = used()
            return model && model.ctx > 0 && model.ctx < SMALL_SERVER_CONTEXT ? model : undefined
          }
          return (
            <div class="flex flex-col gap-2" data-slot="settings-server" data-server={server.label}>
              <div class="flex items-center gap-2">
                <div class="settings-page-row-copy">
                  <span data-slot="settings-v2-row-title" class="truncate">
                    {server.label}
                  </span>
                  <span class="settings-page-row-line truncate" title={offered()} data-slot="settings-server-models">
                    {offered()}
                  </span>
                  {/* the agent's instructions and tools take a good part of a small context before the first word */}
                  <Show when={small()}>
                    {(model) => (
                      <span class="settings-page-row-line" data-slot="settings-server-small">
                        {language.t("settings.links.servers.small", {
                          model: model().label,
                          context: model().ctx.toLocaleString(language.intl()),
                        })}
                      </span>
                    )}
                  </Show>
                  <For each={notes()[server.id] ?? []}>
                    {(line) => (
                      <span class="settings-page-row-line" data-slot="settings-server-notice">
                        {line}
                      </span>
                    )}
                  </For>
                </div>
                <ButtonV2
                  variant="neutral"
                  class="max-w-[220px] shrink-0 whitespace-nowrap"
                  disabled={busy()}
                  aria-expanded={picking() === server.id}
                  onClick={() => setPicking((id) => (id === server.id ? undefined : server.id))}
                  data-action="settings-server-default"
                >
                  <span class="truncate">{chosen()?.label ?? language.t("settings.links.servers.notDefault")}</span>
                  <IconV2 name="chevron-down" class={picking() === server.id ? "rotate-180" : ""} />
                </ButtonV2>
                <ButtonV2
                  variant="neutral"
                  class="shrink-0 whitespace-nowrap"
                  disabled={busy()}
                  onClick={() => void refresh(server.id)}
                  data-action="settings-server-refresh"
                >
                  {language.t("settings.links.servers.refresh")}
                </ButtonV2>
                <ButtonV2
                  variant="danger"
                  class="shrink-0 whitespace-nowrap"
                  disabled={busy()}
                  onClick={() => askRemove(server)}
                  data-action="settings-server-remove"
                >
                  {language.t("settings.links.servers.remove")}
                </ButtonV2>
              </div>
              <Show when={picking() === server.id}>
                <div data-slot="settings-server-models-panel">
                  <ServerModelList
                    models={server.models}
                    current={chosen()?.id}
                    search={server.models.length > SEARCH_FROM}
                    disabled={busy()}
                    onPick={(model) => pick(server.id, model)}
                    onClear={() => pick(null, null)}
                  />
                </div>
              </Show>
            </div>
          )
        }}
      </For>
      <p class="settings-page-row-line">{language.t("settings.links.servers.intro")}</p>
      <form
        class="flex flex-wrap items-center gap-2"
        data-action="settings-servers-form"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <TextInputV2
          appearance="base"
          value={address()}
          onInput={(event) => {
            setAddress(event.currentTarget.value)
            setContext(undefined)
          }}
          placeholder="http://192.168.1.20:8080"
          aria-label={language.t("settings.links.servers.addressLabel")}
          disabled={busy()}
          autocomplete="off"
          data-slot="settings-server-address"
        />
        <TextInputV2
          type="password"
          appearance="base"
          value={key()}
          onInput={(event) => setKey(event.currentTarget.value)}
          placeholder={language.t("settings.links.servers.keyPlaceholder")}
          aria-label={language.t("settings.links.servers.keyLabel")}
          disabled={busy()}
          autocomplete="new-password"
          data-slot="settings-server-key"
        />
        <Show when={context() !== undefined}>
          <TextInputV2
            appearance="base"
            inputMode="numeric"
            value={String(context() ?? "")}
            onInput={(event) => {
              const n = Number(event.currentTarget.value.replace(/\D/g, ""))
              setContext(Number.isFinite(n) && n > 0 ? n : 0)
            }}
            aria-label={language.t("settings.links.servers.contextLabel")}
            disabled={busy()}
            data-slot="settings-server-context"
          />
        </Show>
        <ButtonV2 type="submit" variant="neutral" disabled={busy() || context() === 0}>
          {language.t("settings.links.remote.go")}
        </ButtonV2>
      </form>
      <Show when={status()}>
        {(text) => (
          <p class="settings-page-row-line" data-slot="settings-servers-status">
            {text()}
          </p>
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
            ? { text: language.t("settings.links.cloud.key"), tone: "ready" }
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
            ? { text: language.t("settings.token.savedPill"), tone: "ready" }
            : { text: language.t("settings.token.none") }
          : undefined
      }
      // saved, the foot removes it; to change it, it is removed and added again
      action={
        saved()
          ? {
              label: language.t("settings.token.remove"),
              destructive: true,
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
        <ButtonV2 type="submit" variant="neutral" disabled={commands.busy("token") || !value().trim()}>
          {language.t("settings.token.save")}
        </ButtonV2>
      </form>
    </LinkCard>
  )
}

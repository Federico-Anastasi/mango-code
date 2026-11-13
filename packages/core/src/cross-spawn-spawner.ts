import type * as Arr from "effect/Array"
import { NodeFileSystem, NodeSink, NodeStream } from "@effect/platform-node"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import type * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId,
} from "effect/unstable/process/ChildProcessSpawner"
import * as NodeChildProcess from "node:child_process"
import { PassThrough } from "node:stream"
import launch from "cross-spawn"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem, path } from "./effect/app-node-platform"

const toError = (err: unknown): Error => (err instanceof globalThis.Error ? err : new globalThis.Error(String(err)))

const toTag = (err: NodeJS.ErrnoException): PlatformError.SystemErrorTag => {
  switch (err.code) {
    case "ENOENT":
      return "NotFound"
    case "EACCES":
      return "PermissionDenied"
    case "EEXIST":
      return "AlreadyExists"
    case "EISDIR":
      return "BadResource"
    case "ENOTDIR":
      return "BadResource"
    case "EBUSY":
      return "Busy"
    case "ELOOP":
      return "BadResource"
    default:
      return "Unknown"
  }
}

const flatten = (command: ChildProcess.Command) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const opts: Array<ChildProcess.PipeOptions> = []

  const walk = (cmd: ChildProcess.Command): void => {
    switch (cmd._tag) {
      case "StandardCommand":
        commands.push(cmd)
        return
      case "PipedCommand":
        walk(cmd.left)
        opts.push(cmd.options)
        walk(cmd.right)
        return
    }
  }

  walk(command)
  if (commands.length === 0) throw new Error("flatten produced empty commands array")
  const [head, ...tail] = commands
  return {
    commands: [head, ...tail] as Arr.NonEmptyReadonlyArray<ChildProcess.StandardCommand>,
    opts,
  }
}

const toPlatformError = (
  method: string,
  err: NodeJS.ErrnoException,
  command: ChildProcess.Command,
): PlatformError.PlatformError => {
  const cmd = flatten(command)
    .commands.map((x) => `${x.command} ${x.args.join(" ")}`)
    .join(" | ")
  return PlatformError.systemError({
    _tag: toTag(err),
    module: "ChildProcess",
    method,
    pathOrDescriptor: cmd,
    syscall: err.syscall,
    cause: err,
  })
}

type ExitSignal = Deferred.Deferred<readonly [code: number | null, signal: NodeJS.Signals | null]>

// mango-code: on Windows a program a process leaves running (`server &` in Git Bash, `start /b` in cmd) inherits its
// stdout and stderr, so they stay open after the process exits and "close" comes only when that program ends. For a
// command marked with `leavesRunning`, the process counts as ended once, after its own exit, its output has been quiet
// this long and all that arrived has reached the reader (what still arrives is its own), and at most this long after
// it; what that program writes later is read and dropped: a pipe nobody reads would block it once full, a pipe closed
// under it makes its writes fail. Other callers (git, ripgrep, MCP servers) keep closing their pipes when they stop
// reading.
const HELD_OUTPUT_GRACE_MS = 1000
const HELD_OUTPUT_MAX_MS = 10_000

/**
 * What became of a command marked with `leavesRunning`: `exited` the time its process exited, `held` when its end
 * came while a program it left running still held its output (whose later writes are not read).
 */
type Held = { exited?: number; held: boolean }

// The pieces of output taken from the pipes and those handed to the reader, and when the last one was taken.
type Watch = Held & { taken: number; given: number; last: number }

const holding = new WeakMap<ChildProcess.Command, Watch>()

/**
 * Marks a command that may leave programs running in the background (the agent's shell tool): on Windows it ends
 * without waiting for them, and its output stays drained for them. The command's output is meant to be read whole
 * (stdout, stderr or all). The record fills in as the command runs.
 */
export function leavesRunning(command: ChildProcess.StandardCommand): Readonly<Held> {
  const watch: Watch = { held: false, taken: 0, given: 0, last: 0 }
  holding.set(command, watch)
  return watch
}

const exited = (proc: NodeChildProcess.ChildProcess) => proc.exitCode !== null || proc.signalCode !== null

// With no reader left, a flowing stream drops what arrives until the last holder of the pipe ends.
function drain(proc: NodeChildProcess.ChildProcess) {
  ;[proc.stdout, proc.stderr].forEach((stream) => {
    if (stream && !stream.destroyed) stream.resume()
  })
}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const cwd = Effect.fnUntraced(function* (opts: ChildProcess.CommandOptions) {
    if (Predicate.isUndefined(opts.cwd)) return undefined
    yield* fs.access(opts.cwd)
    return path.resolve(opts.cwd)
  })

  const env = (opts: ChildProcess.CommandOptions) =>
    opts.extendEnv ? { ...globalThis.process.env, ...opts.env } : opts.env

  const input = (x: ChildProcess.CommandInput | undefined): NodeChildProcess.IOType | undefined =>
    Stream.isStream(x) ? "pipe" : x

  const output = (x: ChildProcess.CommandOutput | undefined): NodeChildProcess.IOType | undefined =>
    Sink.isSink(x) ? "pipe" : x

  const stdin = (opts: ChildProcess.CommandOptions): ChildProcess.StdinConfig => {
    const cfg: ChildProcess.StdinConfig = { stream: "pipe", encoding: "utf-8", endOnDone: true }
    if (Predicate.isUndefined(opts.stdin)) return cfg
    if (typeof opts.stdin === "string") return { ...cfg, stream: opts.stdin }
    if (Stream.isStream(opts.stdin)) return { ...cfg, stream: opts.stdin }
    return {
      stream: opts.stdin.stream,
      encoding: opts.stdin.encoding ?? cfg.encoding,
      endOnDone: opts.stdin.endOnDone ?? cfg.endOnDone,
    }
  }

  const stdio = (opts: ChildProcess.CommandOptions, key: "stdout" | "stderr"): ChildProcess.StdoutConfig => {
    const cfg = opts[key]
    if (Predicate.isUndefined(cfg)) return { stream: "pipe" }
    if (typeof cfg === "string") return { stream: cfg }
    if (Sink.isSink(cfg)) return { stream: cfg }
    return { stream: cfg.stream }
  }

  const fds = (opts: ChildProcess.CommandOptions) => {
    if (Predicate.isUndefined(opts.additionalFds)) return []
    return Object.entries(opts.additionalFds)
      .flatMap(([name, config]) => {
        const fd = ChildProcess.parseFdName(name)
        return Predicate.isUndefined(fd) ? [] : [{ fd, config }]
      })
      .toSorted((a, b) => a.fd - b.fd)
  }

  const stdios = (
    sin: ChildProcess.StdinConfig,
    sout: ChildProcess.StdoutConfig,
    serr: ChildProcess.StderrConfig,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ): NodeChildProcess.StdioOptions => {
    const pipe = (x: NodeChildProcess.IOType | undefined) =>
      process.platform === "win32" && x === "pipe" ? "overlapped" : x
    const arr: Array<NodeChildProcess.IOType | undefined> = [
      pipe(input(sin.stream)),
      pipe(output(sout.stream)),
      pipe(output(serr.stream)),
    ]
    if (extra.length === 0) return arr as NodeChildProcess.StdioOptions
    const max = extra.reduce((acc, x) => Math.max(acc, x.fd), 2)
    for (let i = 3; i <= max; i++) arr[i] = "ignore"
    for (const x of extra) arr[x.fd] = pipe("pipe")
    return arr as NodeChildProcess.StdioOptions
  }

  const setupFds = Effect.fnUntraced(function* (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    extra: ReadonlyArray<{ fd: number; config: ChildProcess.AdditionalFdConfig }>,
  ) {
    if (extra.length === 0) {
      return {
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }
    }

    const ins = new Map<number, Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError>>()
    const outs = new Map<number, Stream.Stream<Uint8Array, PlatformError.PlatformError>>()

    for (const x of extra) {
      const node = proc.stdio[x.fd]
      switch (x.config.type) {
        case "input": {
          let sink: Sink.Sink<void, Uint8Array, never, PlatformError.PlatformError> = Sink.drain
          if (node && "write" in node) {
            sink = NodeSink.fromWritable({
              evaluate: () => node,
              onError: (err) => toPlatformError(`fromWritable(fd${x.fd})`, toError(err), command),
              endOnDone: true,
            })
          }
          if (x.config.stream) yield* Effect.forkScoped(Stream.run(x.config.stream, sink))
          ins.set(x.fd, sink)
          break
        }
        case "output": {
          let stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.empty
          if (node && "read" in node) {
            const tap = new PassThrough()
            node.on("error", (err) => tap.destroy(toError(err)))
            node.pipe(tap)
            stream = NodeStream.fromReadable({
              evaluate: () => tap,
              onError: (err) => toPlatformError(`fromReadable(fd${x.fd})`, toError(err), command),
            })
          }
          if (x.config.sink) stream = Stream.transduce(stream, x.config.sink)
          outs.set(x.fd, stream)
          break
        }
      }
    }

    return {
      getInputFd: (fd: number) => ins.get(fd) ?? Sink.drain,
      getOutputFd: (fd: number) => outs.get(fd) ?? Stream.empty,
    }
  })

  const setupStdin = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    cfg: ChildProcess.StdinConfig,
  ) =>
    Effect.suspend(() => {
      let sink: Sink.Sink<void, unknown, never, PlatformError.PlatformError> = Sink.drain
      if (Predicate.isNotNull(proc.stdin)) {
        sink = NodeSink.fromWritable({
          evaluate: () => proc.stdin!,
          onError: (err) => toPlatformError("fromWritable(stdin)", toError(err), command),
          endOnDone: cfg.endOnDone,
          encoding: cfg.encoding,
        })
      }
      if (Stream.isStream(cfg.stream)) return Effect.as(Effect.forkScoped(Stream.run(cfg.stream, sink)), sink)
      return Effect.succeed(sink)
    })

  const setupOutput = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    out: ChildProcess.StdoutConfig,
    err: ChildProcess.StderrConfig,
    held: Watch | undefined,
  ) => {
    // The pipes are not closed under a program that may still hold them: the release drains them instead. What is taken
    // from the pipes and what reaches the reader tell the end whether output is still on its way.
    const read = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
      held
        ? Stream.tap(stream, () =>
            Effect.sync(() => {
              held.taken++
              held.last = Date.now()
            }),
          )
        : stream
    const give = <A, E>(stream: Stream.Stream<A, E>) =>
      held ? Stream.tap(stream, () => Effect.sync(() => held.given++)) : stream
    let stdout = proc.stdout
      ? read(
          NodeStream.fromReadable({
            evaluate: () => proc.stdout!,
            onError: (cause) => toPlatformError("fromReadable(stdout)", toError(cause), command),
            closeOnDone: !held,
          }),
        )
      : Stream.empty
    let stderr = proc.stderr
      ? read(
          NodeStream.fromReadable({
            evaluate: () => proc.stderr!,
            onError: (cause) => toPlatformError("fromReadable(stderr)", toError(cause), command),
            closeOnDone: !held,
          }),
        )
      : Stream.empty

    if (Sink.isSink(out.stream)) stdout = Stream.transduce(stdout, out.stream)
    if (Sink.isSink(err.stream)) stderr = Stream.transduce(stderr, err.stream)

    return { stdout: give(stdout), stderr: give(stderr), all: give(Stream.merge(stdout, stderr)) }
  }

  const spawn = (command: ChildProcess.StandardCommand, opts: NodeChildProcess.SpawnOptions, held: Watch | undefined) =>
    Effect.callback<readonly [NodeChildProcess.ChildProcess, ExitSignal], PlatformError.PlatformError>((resume) => {
      const signal = Deferred.makeUnsafe<readonly [code: number | null, signal: NodeJS.Signals | null]>()
      // A program from the Microsoft Store (PowerShell 7 is one) is an app execution alias that cannot be read:
      // cross-spawn does not see it is an executable and runs it through cmd, which drops an argument's text after its
      // first line break. A full path to an executable needs nothing cross-spawn adds, so it is started directly.
      // Neither does a command run by a shell, and there cross-spawn turns an exit code of 1 into a "missing program"
      // error in place of "exit": a shell stopped by taskkill exits with 1, and its end would go unseen.
      const direct =
        process.platform === "win32" && (!!opts.shell || /^[A-Za-z]:[\\/].*\.(exe|com)$/i.test(command.command))
      const proc = direct
        ? NodeChildProcess.spawn(command.command, command.args, opts)
        : launch(command.command, command.args, opts)
      let end = false
      let exit: readonly [code: number | null, signal: NodeJS.Signals | null] | undefined
      const finish = (args: readonly [code: number | null, signal: NodeJS.Signals | null]) => {
        if (end) return
        end = true
        Deferred.doneUnsafe(signal, Exit.succeed(exit ?? args))
      }
      proc.on("error", (err) => {
        resume(Effect.fail(toPlatformError("spawn", err, command)))
      })
      // The end waits while output arrives or has not reached the reader, up to the limit; then a program holds the
      // pipes. A loop that was busy runs its timers before reading what came meanwhile: one more look after its reads.
      const settle = (
        watch: Watch,
        at: number,
        args: readonly [code: number | null, signal: NodeJS.Signals | null],
        looked = false,
      ) => {
        if (end) return
        const now = Date.now()
        const quiet = now - Math.max(at, watch.last)
        const pending =
          watch.taken > watch.given || [proc.stdout, proc.stderr].some((stream) => !!stream && stream.readableLength > 0)
        if ((pending || quiet < HELD_OUTPUT_GRACE_MS) && now - at < HELD_OUTPUT_MAX_MS) {
          setTimeout(() => settle(watch, at, args), pending ? 100 : HELD_OUTPUT_GRACE_MS - quiet).unref()
          return
        }
        if (!looked && now - at < HELD_OUTPUT_MAX_MS) {
          setImmediate(() => settle(watch, at, args, true)).unref()
          return
        }
        watch.held = true
        finish(args)
      }
      proc.on("exit", (...args) => {
        exit = args
        if (!held) return
        held.exited = Date.now()
        settle(held, held.exited, args)
      })
      proc.on("close", (...args) => finish(args))
      proc.on("spawn", () => {
        resume(Effect.succeed([proc, signal]))
      })
      return Effect.sync(() => {
        proc.kill("SIGTERM")
      })
    })

  const killGroup = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ) => {
    if (globalThis.process.platform === "win32") {
      // An exited process's number may already belong to another program: taskkill would stop that one and its tree.
      if (exited(proc)) return Effect.void
      return Effect.callback<void, PlatformError.PlatformError>((resume) => {
        NodeChildProcess.exec(`taskkill /pid ${proc.pid} /T /F`, { windowsHide: true }, (err) => {
          // A process that ended while taskkill ran has been stopped all the same.
          if (err && !exited(proc)) return resume(Effect.fail(toPlatformError("kill", toError(err), command)))
          resume(Effect.void)
        })
      })
    }

    return Effect.try({
      try: () => {
        globalThis.process.kill(-proc.pid!, signal)
      },
      catch: (err) => toPlatformError("kill", toError(err), command),
    })
  }

  const killOne = (
    command: ChildProcess.StandardCommand,
    proc: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ) =>
    Effect.suspend(() => {
      if (proc.kill(signal)) return Effect.void
      return Effect.fail(toPlatformError("kill", new Error("Failed to kill child process"), command))
    })

  const timeout =
    (
      proc: NodeChildProcess.ChildProcess,
      command: ChildProcess.StandardCommand,
      opts: ChildProcess.KillOptions | undefined,
    ) =>
    <A, E, R>(
      f: (
        command: ChildProcess.StandardCommand,
        proc: NodeChildProcess.ChildProcess,
        signal: NodeJS.Signals,
      ) => Effect.Effect<A, E, R>,
    ) => {
      const signal = opts?.killSignal ?? "SIGTERM"
      if (Predicate.isUndefined(opts?.forceKillAfter)) return f(command, proc, signal)
      return Effect.timeoutOrElse(f(command, proc, signal), {
        duration: opts.forceKillAfter,
        orElse: () => f(command, proc, "SIGKILL"),
      })
    }

  const source = (handle: ChildProcessHandle, from: ChildProcess.PipeFromOption | undefined) => {
    const opt = from ?? "stdout"
    switch (opt) {
      case "stdout":
        return handle.stdout
      case "stderr":
        return handle.stderr
      case "all":
        return handle.all
      default: {
        const fd = ChildProcess.parseFdName(opt)
        return Predicate.isNotUndefined(fd) ? handle.getOutputFd(fd) : handle.stdout
      }
    }
  }

  const spawnCommand: (
    command: ChildProcess.Command,
  ) => Effect.Effect<ChildProcessHandle, PlatformError.PlatformError, Scope.Scope> = Effect.fnUntraced(
    function* (command) {
      switch (command._tag) {
        case "StandardCommand": {
          const sin = stdin(command.options)
          const sout = stdio(command.options, "stdout")
          const serr = stdio(command.options, "stderr")
          const extra = fds(command.options)
          const dir = yield* cwd(command.options)
          const held = process.platform === "win32" ? holding.get(command) : undefined

          const [proc, signal] = yield* Effect.acquireRelease(
            spawn(
              command,
              {
                cwd: dir,
                env: env(command.options),
                stdio: stdios(sin, sout, serr, extra),
                detached: command.options.detached ?? process.platform !== "win32",
                shell: command.options.shell,
                windowsHide: process.platform === "win32",
              },
              held,
            ),
            Effect.fnUntraced(function* ([proc, signal]) {
              const done = yield* Deferred.isDone(signal)
              const kill = timeout(proc, command, command.options)
              if (done) {
                const [code] = yield* Deferred.await(signal)
                if (held) drain(proc)
                if (process.platform === "win32") return yield* Effect.void
                if (code !== 0 && Predicate.isNotNull(code)) return yield* Effect.ignore(kill(killGroup))
                return yield* Effect.void
              }
              const send = (s: NodeJS.Signals) =>
                Effect.catch(killGroup(command, proc, s), () => killOne(command, proc, s))
              const sig = command.options.killSignal ?? "SIGTERM"
              const attempt = send(sig).pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid)
              const escalated = command.options.forceKillAfter
                ? Effect.timeoutOrElse(attempt, {
                    duration: command.options.forceKillAfter,
                    orElse: () => send("SIGKILL").pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid),
                  })
                : attempt
              yield* Effect.ignore(escalated)
              if (held) drain(proc)
            }),
          )

          const fd = yield* setupFds(command, proc, extra)
          const out = setupOutput(command, proc, sout, serr, held)
          let ref = true
          return makeHandle({
            pid: ProcessId(proc.pid!),
            stdin: yield* setupStdin(command, proc, sin),
            stdout: out.stdout,
            stderr: out.stderr,
            all: out.all,
            getInputFd: fd.getInputFd,
            getOutputFd: fd.getOutputFd,
            isRunning: Effect.map(Deferred.isDone(signal), (done) => !done),
            exitCode: Effect.flatMap(Deferred.await(signal), ([code, signal]) => {
              if (Predicate.isNotNull(code)) return Effect.succeed(ExitCode(code))
              return Effect.fail(
                toPlatformError(
                  "exitCode",
                  new Error(`Process interrupted due to receipt of signal: '${signal}'`),
                  command,
                ),
              )
            }),
            kill: (opts?: ChildProcess.KillOptions) => {
              const sig = opts?.killSignal ?? "SIGTERM"
              const send = (s: NodeJS.Signals) =>
                Effect.catch(killGroup(command, proc, s), () => killOne(command, proc, s))
              const attempt = send(sig).pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid)
              if (!opts?.forceKillAfter) return attempt
              return Effect.timeoutOrElse(attempt, {
                duration: opts.forceKillAfter,
                orElse: () => send("SIGKILL").pipe(Effect.andThen(Deferred.await(signal)), Effect.asVoid),
              })
            },
            unref: Effect.sync(() => {
              if (ref) {
                proc.unref()
                ref = false
              }
              return Effect.sync(() => {
                if (!ref) {
                  proc.ref()
                  ref = true
                }
              })
            }),
          })
        }
        case "PipedCommand": {
          const flat = flatten(command)
          const [head, ...tail] = flat.commands
          let handle = spawnCommand(head)
          for (let i = 0; i < tail.length; i++) {
            const next = tail[i]
            const opts = flat.opts[i] ?? {}
            const sin = stdin(next.options)
            const stream = Stream.unwrap(Effect.map(handle, (x) => source(x, opts.from)))
            const to = opts.to ?? "stdin"
            if (to === "stdin") {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            const fd = ChildProcess.parseFdName(to)
            if (Predicate.isUndefined(fd)) {
              handle = spawnCommand(
                ChildProcess.make(next.command, next.args, {
                  ...next.options,
                  stdin: { ...sin, stream },
                }),
              )
              continue
            }
            handle = spawnCommand(
              ChildProcess.make(next.command, next.args, {
                ...next.options,
                additionalFds: {
                  ...next.options.additionalFds,
                  [ChildProcess.fdName(fd) as `fd${number}`]: { type: "input", stream },
                },
              }),
            )
          }
          return yield* handle
        }
      }
    },
  )

  return makeSpawner(spawnCommand)
})

const layer: Layer.Layer<ChildProcessSpawner, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  ChildProcessSpawner,
  make,
)

export const node = makeGlobalNode({ service: ChildProcessSpawner, layer, deps: [filesystem, path] })

export * as CrossSpawnSpawner from "./cross-spawn-spawner"

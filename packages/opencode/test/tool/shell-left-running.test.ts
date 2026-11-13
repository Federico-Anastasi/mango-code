import { describe, expect, test } from "bun:test"
import { Shell } from "@opencode-ai/core/shell"
import { LeftRunning } from "../../src/tool/shell/left-running"

// `mark`: the value of the variable the shell tool gives the command that started the process (the run's own, as
// `run` below makes it from the number).
const proc = (
  pid: number,
  parent: number,
  started: number,
  mark?: number,
  name = "node.exe",
  extra: { window?: boolean; unread?: boolean } = {},
) => ({
  pid,
  parent,
  started,
  name,
  command: `${name} server.js`,
  mark: mark === undefined ? undefined : `run-${mark}`,
  ...extra,
})
// The run's shell (PID 99) has ended.
const run = (sessionID: string, mark: number, command = "npm run dev") => ({
  sessionID,
  mark: `run-${mark}`,
  pid: 99,
  start: 10_000,
  end: 20_000,
  command,
})
// Any true table holds other processes too: the agent itself, PowerShell.
const others = [proc(4, 0, 1_000, undefined, "System"), proc(9, 4, 2_000, undefined, "agent.exe")]
const pids = (procs: { pid: number }[]) => procs.map((item) => item.pid)
const recorder = () => {
  const killed: number[][] = []
  return {
    killed,
    kill: async (procs: { pid: number }[]) => {
      killed.push(pids(procs))
      return true
    },
  }
}

describe("programs left running by the shell", () => {
  test("a process with the command's mark is left running, though what started it has ended; others are not", () => {
    const table = [
      // `server &` in Git Bash: the copy of bash that waits for the server, whose parent (the real bash) has ended
      proc(150, 120, 12_000, 100, "bash.exe"),
      proc(200, 150, 12_100, 100, "python.exe"),
      proc(201, 200, 12_200, 100, "conhost.exe"),
      // `cmd /c start prog`: cmd has ended, prog's parent is gone
      proc(250, 130, 13_000, 100, "prog.exe"),
      // a PID taken later by another program, with no mark, and what that one started
      proc(130, 1, 40_000, undefined, "chrome.exe"),
      proc(300, 130, 41_000, undefined, "chrome.exe"),
      // the mark of another command
      proc(400, 7, 15_000, 101),
      // a process with the mark created before the command began cannot be one of its own
      proc(500, 9, 5_000, 100),
      // nor one created long after it ended (a terminal it left open, used later)
      proc(600, 9, 25_000, 100),
    ]
    expect(LeftRunning.survivors(table, run("ses_a", 100)).map((item) => [item.pid, item.name])).toEqual([
      [200, "python.exe"],
      [250, "prog.exe"],
    ])
  })

  test("a program started by the shell without the mark is the command's, while the command ran", () => {
    const table = [
      // `Start-Process -UseNewEnvironment`, `env -i server &`: a direct child of the shell with an environment of its own
      proc(200, 99, 12_000, undefined, "python.exe"),
      // the shell's number taken by another program after the command, and what that one started
      proc(300, 99, 40_000, undefined, "node.exe"),
    ]
    expect(pids(LeftRunning.survivors(table, run("ses_a", 100)))).toEqual([200])
  })

  test("a shell left alone is the program; a program below another one is part of it", () => {
    const table = [
      proc(150, 1, 12_000, 100, "cmd.exe"),
      proc(151, 150, 12_000, 100, "conhost.exe"),
      // npm run dev: npm (node) runs cmd, which runs the real server
      proc(200, 1, 12_000, 100, "node.exe"),
      proc(201, 200, 12_100, 100, "cmd.exe"),
      proc(202, 201, 12_200, 100, "node.exe"),
      // a program that empties the environment of what it starts, which starts one that sets it again
      proc(300, 1, 12_000, 100, "launcher.exe"),
      proc(301, 300, 12_100, undefined, "env.exe"),
      proc(302, 301, 12_200, 100, "worker.exe"),
    ]
    expect(pids(LeftRunning.survivors(table, run("ses_a", 100)))).toEqual([150, 200, 300])
  })

  test("a program with a window of its own, and what it started, is not listed", () => {
    const table = [
      // `start http://localhost:3000` when the browser was closed: the browser and its helpers
      proc(200, 150, 12_000, 100, "chrome.exe", { window: true }),
      proc(201, 200, 12_100, 100, "chrome.exe"),
      // `start notepad` from the copy of bash that holds it: neither is listed
      proc(300, 1, 12_000, 100, "bash.exe"),
      proc(301, 300, 12_100, 100, "notepad.exe", { window: true }),
      // a server in the background
      proc(400, 1, 12_000, 100, "node.exe"),
    ]
    expect(pids(LeftRunning.survivors(table, run("ses_a", 100)))).toEqual([400])
  })

  test("the tree of a program holds only what it started after it started, and no program with a window", () => {
    const root = proc(200, 100, 15_000)
    const table = [
      root,
      proc(201, 200, 16_000),
      proc(202, 201, 17_000),
      proc(203, 200, 1_000),
      // a browser the server opened, with its helper
      proc(204, 200, 16_000, undefined, "chrome.exe", { window: true }),
      proc(205, 204, 16_500, undefined, "chrome.exe"),
    ]
    expect(pids(LeftRunning.tree(table, root))).toEqual([202, 201, 200])
  })

  test("each conversation sees its own programs, and a run that left nothing is forgotten", async () => {
    await LeftRunning.record(run("ses_one", 50, "bun index.html"))
    await LeftRunning.record(run("ses_two", 60))
    await LeftRunning.record(run("ses_one", 70, "echo ciao"))
    const tables = [
      [...others, proc(500, 1, 15_000, 50), proc(600, 1, 15_000, 60)],
      // Later a process with the mark of "echo ciao" shows up: the run is no longer looked at.
      [...others, proc(500, 1, 15_000, 50), proc(600, 1, 15_000, 60), proc(700, 1, 15_000, 70)],
    ]
    let reads = 0
    const read = async () => tables[Math.min(reads++, 1)]

    expect(await LeftRunning.list("ses_one", read)).toEqual([
      { pid: 500, started: 15_000, name: "node.exe", command: "node.exe server.js", asked: "bun index.html" },
    ])
    expect(pids(await LeftRunning.list("ses_two", read))).toEqual([600])
    expect(pids(await LeftRunning.list("ses_one", read))).toEqual([500])
    expect(reads).toBe(3)
    // Nothing recorded for this conversation: the table is not read at all.
    expect(await LeftRunning.list("ses_none", read)).toEqual([])
    expect(reads).toBe(3)
  })

  test("a run is not forgotten while a process of its time could not be read", async () => {
    await LeftRunning.record(run("ses_unread", 53))
    const unread = [...others, proc(530, 1, 15_000, undefined, "node.exe", { unread: true })]
    expect(await LeftRunning.list("ses_unread", async () => unread)).toEqual([])
    // An unreadable process from before the command does not keep it.
    await LeftRunning.record(run("ses_unread_old", 54))
    expect(
      await LeftRunning.list("ses_unread_old", async () => [
        ...others,
        proc(540, 1, 5_000, undefined, "x.exe", { unread: true }),
      ]),
    ).toEqual([])
    const later = async () => [...others, proc(530, 1, 15_000, 53), proc(540, 1, 15_000, 54)]
    expect(pids(await LeftRunning.list("ses_unread", later))).toEqual([530])
    expect(await LeftRunning.list("ses_unread_old", later)).toEqual([])
  })

  test("two lists read at once forget a run once and leave the other conversations' runs alone", async () => {
    await LeftRunning.record(run("ses_twice", 51))
    await LeftRunning.record(run("ses_kept", 61))
    const read = async () => {
      await Bun.sleep(5)
      return [...others, proc(610, 1, 15_000, 61)]
    }
    expect(await Promise.all([LeftRunning.list("ses_twice", read), LeftRunning.list("ses_twice", read)])).toEqual([
      [],
      [],
    ])
    expect(pids(await LeftRunning.list("ses_kept", read))).toEqual([610])
  })

  test("a table that cannot be read, or comes back empty, forgets nothing and is an error", async () => {
    await LeftRunning.record(run("ses_blind", 52))
    await expect(LeftRunning.list("ses_blind", async () => [])).rejects.toThrow()
    await expect(
      LeftRunning.list("ses_blind", async () => {
        throw new Error("PowerShell did not answer")
      }),
    ).rejects.toThrow("PowerShell did not answer")
    await expect(
      LeftRunning.stop({ sessionID: "ses_blind", pid: 520, started: 15_000 }, async () => []),
    ).rejects.toThrow()
    // Once the table is read again, the program is there.
    expect(pids(await LeftRunning.list("ses_blind", async () => [...others, proc(520, 1, 15_000, 52)]))).toEqual([520])
  })

  test("Stop refuses a PID that now belongs to another program, and stops the tree it checked, deepest first, then the shell that waited for it", async () => {
    await LeftRunning.record(run("ses_reuse", 80, "bun index.html"))
    const kill = recorder()
    let reads = 0
    const read = async () => {
      reads++
      return [
        ...others,
        // `cmd /c "server & other"` waits for the server only: it goes with it
        proc(799, 1, 14_500, 80, "cmd.exe"),
        proc(798, 799, 14_500, 80, "conhost.exe"),
        proc(800, 799, 15_000, 80),
        proc(801, 800, 16_000, 80),
        proc(802, 801, 17_000, 80),
      ]
    }
    expect(await LeftRunning.stop({ sessionID: "ses_reuse", pid: 800, started: 14_000 }, read, kill.kill)).toBe("gone")
    expect(await LeftRunning.stop({ sessionID: "ses_other", pid: 800, started: 15_000 }, read, kill.kill)).toBe("gone")
    expect(kill.killed).toEqual([])
    reads = 0
    expect(await LeftRunning.stop({ sessionID: "ses_reuse", pid: 800, started: 15_000 }, read, kill.kill)).toBe(
      "stopped",
    )
    expect(kill.killed).toEqual([[802, 801, 800, 799]])
    // One reading, the one checked: nothing in between.
    expect(reads).toBe(1)
  })

  test("Stop ends only a shell of the command that waits for the program and nothing else", async () => {
    const cases = [
      // a shell with another living program
      [proc(850, 1, 12_000, 85, "cmd.exe"), proc(852, 850, 12_100, undefined, "other.exe")],
      // a shell without the command's mark
      [proc(850, 1, 12_000, undefined, "cmd.exe")],
      // a shell from before the command
      [proc(850, 1, 5_000, 85, "cmd.exe")],
    ]
    for (const [index, shell] of cases.entries()) {
      await LeftRunning.record(run(`ses_shell_${index}`, 85))
      const kill = recorder()
      const read = async () => [...others, ...shell, proc(851, 850, 12_050, 85)]
      expect(
        await LeftRunning.stop({ sessionID: `ses_shell_${index}`, pid: 851, started: 12_050 }, read, kill.kill),
      ).toBe("stopped")
      expect(kill.killed).toEqual([[851]])
    }
  })

  test("Stop says so when the program did not stop", async () => {
    await LeftRunning.record(run("ses_stubborn", 81))
    const read = async () => [...others, proc(810, 1, 15_000, 81)]
    expect(
      await LeftRunning.stop({ sessionID: "ses_stubborn", pid: 810, started: 15_000 }, read, async () => false),
    ).toBe("failed")
  })

  test("Stop leaves alone a shell that runs another program too", async () => {
    await LeftRunning.record(run("ses_two_servers", 95))
    const kill = recorder()
    const read = async () => [
      ...others,
      proc(950, 1, 15_000, 95, "cmd.exe"),
      proc(951, 950, 15_100, 95),
      proc(952, 950, 15_200, 95),
    ]
    expect(pids(await LeftRunning.list("ses_two_servers", read))).toEqual([951, 952])
    expect(await LeftRunning.stop({ sessionID: "ses_two_servers", pid: 951, started: 15_100 }, read, kill.kill)).toBe(
      "stopped",
    )
    expect(kill.killed).toEqual([[951]])
  })

  test("many commands later, the server started first is still listed", async () => {
    await LeftRunning.record(run("ses_long", 90, "npm run dev"))
    const read = async () => [...others, proc(900, 1, 15_000, 90)]
    for (const pid of Array.from({ length: 600 }, (_, i) => 10_000 + i))
      await LeftRunning.record(run("ses_long", pid, "echo ciao"), read)
    expect((await LeftRunning.list("ses_long", read)).map((item) => [item.pid, item.asked])).toEqual([
      [900, "npm run dev"],
    ])
  })

  const windows = process.platform === "win32"
  // A program of the test, with no window and nothing to say; stopped at the end by its PID and creation time.
  const ping = (env: Record<string, string> = {}) =>
    Bun.spawn(["ping", "-n", "120", "127.0.0.1"], {
      env: { ...process.env, ...env },
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
  const found = async (pid: number) => (await LeftRunning.readTable(0)).find((item) => item.pid === pid)!
  const ended = (child: { exitCode: number | null }) => child.exitCode !== null
  const until = async (check: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms
    while (!check() && Date.now() < end) await Bun.sleep(50)
    return check()
  }

  test.skipIf(!windows)("readings asked close together share one PowerShell", async () => {
    const first = LeftRunning.table()
    expect(LeftRunning.table()).toBe(first)
    expect((await first).length).toBeGreaterThan(0)
    // A command that ended after that reading began needs a new one: its programs may not be in it.
    const later = LeftRunning.table(Date.now() + 1)
    expect(later).not.toBe(first)
    await later
  })

  test.skipIf(!windows)(
    "a process created before the oldest command is not opened, and a window is seen without opening one",
    async () => {
      const child = ping({ [LeftRunning.MARK]: "older" })
      try {
        const self = await found(child.pid)
        expect(self.mark).toBe("older")
        expect(self.window).toBe(false)
        const later = (await LeftRunning.readTable(self.started + 5_000)).find((item) => item.pid === child.pid)
        expect(later?.mark).toBeUndefined()
        // The desktop of whoever runs the tests shows a window (the taskbar, at least).
        expect((await LeftRunning.readTable(0)).some((item) => item.window)).toBe(true)
      } finally {
        LeftRunning.terminate(await found(child.pid))
      }
    },
    30_000,
  )

  test.skipIf(!windows)(
    "Stop never touches a program that took the number of a process in the table",
    async () => {
      const server = ping()
      const stranger = ping()
      const [mine, theirs] = [await found(server.pid), await found(stranger.pid)]
      try {
        expect(LeftRunning.terminate({ pid: theirs.pid, started: theirs.started - 1 })).toBe(true)
        // The table was read before the shell that waited for the server ended: its number is now the stranger's.
        await LeftRunning.record({ ...run("ses_taken", 70), start: mine.started - 100, end: mine.started + 100 })
        const read = async () => [
          ...others,
          { ...theirs, parent: 1, started: mine.started - 50, name: "bash.exe", mark: "run-70" },
          { ...mine, parent: theirs.pid, mark: "run-70" },
        ]
        expect(pids(await LeftRunning.list("ses_taken", read))).toEqual([mine.pid])
        expect(await LeftRunning.stop({ sessionID: "ses_taken", pid: mine.pid, started: mine.started }, read)).toBe(
          "stopped",
        )
        expect(await until(() => ended(server))).toBe(true)
        await Bun.sleep(300)
        expect(ended(stranger)).toBe(false)
      } finally {
        LeftRunning.terminate(mine)
        LeftRunning.terminate(theirs)
      }
      expect(await until(() => ended(stranger))).toBe(true)
    },
    30_000,
  )

  // As the shell tool does: a shell with the command's mark that leaves a program running and ends. The program is
  // listed and Stop ends it with the shell that waited for it; whatever is left of this test's own processes is
  // stopped by PID and creation time at the end.
  const real = (label: string, argv: string[], program: string) =>
    test.skipIf(!windows || !argv[0])(
      `Stop ends the program and what it started, on the real process table [${label}]`,
      async () => {
        const sessionID = `ses_real_${label}`
        const mark = `real-${label}-${Date.now()}`
        const start = Date.now()
        const shell = Bun.spawn(argv, {
          env: { ...process.env, [LeftRunning.MARK]: mark },
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
        await shell.exited
        await LeftRunning.record({ sessionID, mark, pid: shell.pid, start, end: Date.now(), command: "a server" })
        const ours = async () =>
          (await LeftRunning.table(Date.now())).filter(
            (item) =>
              (item.mark === mark || (item.parent === shell.pid && item.started >= start - 1_000)) &&
              item.name !== "conhost.exe",
          )
        const before = await ours()
        try {
          const left = await LeftRunning.list(sessionID)
          expect(left.map((item) => item.name.toLowerCase())).toEqual([program])
          expect(await LeftRunning.stop({ sessionID, pid: left[0].pid, started: left[0].started })).toBe("stopped")
          expect(await ours()).toEqual([])
          expect(await LeftRunning.list(sessionID)).toEqual([])
        } finally {
          before.forEach(LeftRunning.terminate)
        }
      },
      30_000,
    )
  real(
    "powershell",
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process cmd -ArgumentList '/c','ping -n 120 127.0.0.1 >nul' -WindowStyle Hidden",
    ],
    "ping.exe",
  )
  // Without the variable: what `Start-Process -UseNewEnvironment` starts is found as the shell's child.
  real(
    "powershell new environment",
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process ping -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden -UseNewEnvironment",
    ],
    "ping.exe",
  )
  // Git Bash's bin/bash.exe starts the real bash and both leave at once: ping's parent is a copy of bash whose own
  // parent has ended.
  real("bash", [Shell.gitbash() ?? "", "-c", "ping -n 120 127.0.0.1 >/dev/null &"], "ping.exe")
  real("cmd", ["cmd.exe", "/d", "/c", "start /b ping -n 120 127.0.0.1 >nul"], "ping.exe")
})

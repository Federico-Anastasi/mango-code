// How the terminals read a command before running it: a change of folder, and the places a command names, for bash
// and for PowerShell; and how a command runs in Git Bash and in PowerShell.
//
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fromBash, gitBash, movedBy, pathsIn, run } from "@/mango-harness/terminal"

// Windows PowerShell 5.1 takes seconds to start when the machine is busy: the default of 5 s is not a verdict.
setDefaultTimeout(60_000)

// ---- a change of folder

test("a change of folder alone, and one in front of another command, in bash", () => {
  expect(movedBy("cd src", "bash")).toEqual({ cd: "src" })
  expect(movedBy('cd "my site" && npm test', "bash")).toEqual({ folder: "my site", rest: "npm test" })
  expect(movedBy("cd src; python run.py", "bash")).toEqual({ folder: "src", rest: "python run.py" })
})

test("in bash the cmdlets of PowerShell do not change the folder", () => {
  const cmdlets = ["Set-Location src", "chdir src", "Set-Location src; npm test", "chdir src && npm test"]
  expect(cmdlets.filter((command) => movedBy(command, "bash") !== undefined)).toEqual([])
})

test("a change of folder alone, and one in front of another command, in PowerShell", () => {
  expect(movedBy("cd src")).toEqual({ cd: "src" })
  expect(movedBy("Set-Location src")).toEqual({ cd: "src" })
  expect(movedBy('cd "my site" && npm test')).toEqual({ folder: "my site", rest: "npm test" })
  expect(movedBy("chdir src; python run.py")).toEqual({ folder: "src", rest: "python run.py" })
})

test("a command that is not only a change of folder is left to the shell", () => {
  const left = ["cd", "cd -", "cd /d src", "cd src dist", "cd src | more", "ls src", "python run.py", "cd src\nmake"]
  expect(left.filter((command) => movedBy(command) !== undefined)).toEqual([])
  expect(movedBy("cd src 2>/dev/null", "bash")).toEqual({ cd: "src" })
})

// ---- the places a command names

test("the places a command names", () => {
  expect(pathsIn("python C:\\Users\\someone\\run.py")).toEqual(["C:\\Users\\someone\\run.py"])
  expect(pathsIn("python /workspace/run.py 2>/dev/null")).toEqual(["/workspace/run.py"])
  expect(pathsIn("Get-Content ..\\outer\\secret.txt")).toEqual(["..\\outer\\secret.txt"])
  expect(pathsIn("Get-ChildItem ~")).toEqual(["~"])
  expect(pathsIn("Get-ChildItem \\\\server\\share")).toEqual(["\\\\server\\share"])
  expect(pathsIn("Copy-Item a.txt $env:TEMP\\a.txt")).toEqual(["$env:TEMP\\a.txt"])
  expect(pathsIn("python -c \"open('C:/data/x.txt')\"")).toContain("C:/data/x.txt")
  expect(pathsIn("cat /c/Users/someone/notes.txt")).toEqual(["/c/Users/someone/notes.txt"])
  // The root of the disk is a place too: find / goes through the whole computer.
  expect(pathsIn('find / -name "*.csv" 2>/dev/null | head')).toEqual(["/"])
  expect(pathsIn("Get-ChildItem C:\\ -Recurse")).toEqual(["C:\\"])
  expect(pathsIn("ls C:")).toEqual(["C:"])
  expect(pathsIn('python -c "print(6 / 2)"')).toEqual([])
  // A place of Linux inside the command another shell runs; a quoted path with spaces stays whole.
  expect(pathsIn('bash -c "cd /root/project && python -m pytest -v"')).toContain("/root/project")
  expect(pathsIn('type "C:\\Users\\x y\\a.txt"')).toEqual(["C:\\Users\\x y\\a.txt"])
  // The users' folder as a Mac writes it.
  expect(pathsIn("ls -la /Users/ -1")).toEqual(["/Users/"])
})

test("the text of a here-document or a here-string goes to the program: its words are not places", () => {
  const python = "python3 << 'EOF'\nwith open('prices.csv') as f:\n    print(f.read())\nEOF"
  expect(pathsIn(python, "bash")).toEqual([])
  expect(pathsIn("cat <<-EOF > /tmp/out.txt\n\tC: is a drive\n\tEOF\necho done", "bash")).toEqual(["/tmp/out.txt"])
  expect(pathsIn("python -c @'\nwith open('prices.csv') as f:\n    print(f.read())\n'@")).toEqual([])
  expect(pathsIn('Set-Content -Path C:\\Temp\\a.txt -Value @"\nD: and E:\n"@')).toEqual(["C:\\Temp\\a.txt"])
})

test("in bash every form of a place outside the project is one", () => {
  const places: [string, string][] = [
    ["cat /c/Users/someone/notes.txt", "/c/Users/someone/notes.txt"],
    ["ls /c", "/c"],
    ["ls /c/", "/c/"],
    ["ls /cygdrive/c/Users", "/cygdrive/c/Users"],
    ["ls /mnt/c/Users", "/mnt/c/Users"],
    ["cat C:/Users/someone/notes.txt", "C:/Users/someone/notes.txt"],
    ['cat "C:\\Users\\someone\\my notes.txt"', "C:\\Users\\someone\\my notes.txt"],
    ["cat C:\\Users\\someone\\notes.txt", "C:\\Users\\someone\\notes.txt"],
    ["ls ~", "~"],
    ["cat ~/notes.txt", "~/notes.txt"],
    ["cat $HOME/notes.txt", "$HOME/notes.txt"],
    ["cat ${HOME}/notes.txt", "${HOME}/notes.txt"],
    ["cat $USERPROFILE/notes.txt", "$USERPROFILE/notes.txt"],
    ["cp a.txt $TEMP/a.txt", "$TEMP/a.txt"],
    ["cp a.txt $APPDATA/a.txt", "$APPDATA/a.txt"],
    ["echo x > /tmp/out.txt", "/tmp/out.txt"],
    ["ls /tmp", "/tmp"],
    ["python /home/user/app/main.py", "/home/user/app/main.py"],
    ["ls /home", "/home"],
    ["python /app/main.py", "/app/main.py"],
    ["cat /root/.bashrc", "/root/.bashrc"],
    ["cd /root && ls", "/root"],
    ["ls /usr/lib", "/usr/lib"],
    ["ls /etc", "/etc"],
    ["cat /dev/sda", "/dev/sda"],
    ["ls /", "/"],
    ["rm -f /*.tmp", "/*.tmp"],
    ["cat ../outer/secret.txt", "../outer/secret.txt"],
    ["cat src/../../outer/secret.txt", "src/../../outer/secret.txt"],
  ]
  expect(places.filter(([command, place]) => !pathsIn(command, "bash").includes(place))).toEqual([])
})

test("in bash what is not a place: the streams, an address of sed, a relative path, a variable of the project", () => {
  const none = [
    "echo hi > /dev/null",
    "ls nothing 2>/dev/null",
    "ls nothing &>/dev/null",
    "echo hi >&2",
    "echo hi > /dev/stderr",
    "sed -n '/a/p' notes.txt",
    "sed -i 's/a/b/' notes.txt",
    "cat src/app.js",
    "cat ./src/app.js",
    "git diff HEAD..main",
    "git log --format=%H",
    "export NODE_ENV=test && npm test",
    "echo $PWD",
    'grep "\\.py$" a.txt',
    'python -c "print(6 / 2)"',
    "python3 -c \"print('\\nRiva\\n')\"",
    'bash -c "echo hi 2>/dev/null"',
  ]
  expect(none.flatMap((command) => pathsIn(command, "bash"))).toEqual([])
  expect(pathsIn("cat /c/Users/x/a.txt 2>/dev/null", "bash")).toEqual(["/c/Users/x/a.txt"])
})

test("a word that names the root of the drive is a place, whatever follows the separator", () => {
  expect(pathsIn("rm -f /*.tmp")).toEqual(["/*.tmp"])
  expect(pathsIn("cp \\* storico")).toEqual(["\\*"])
  expect(pathsIn("cat /.x")).toEqual(["/.x"])
  expect(pathsIn("dir \\Windows\\x")).toEqual(["\\Windows\\x"])
  expect(pathsIn('ls -la "./già fatti"/*.log')).toEqual(["/*.log"])
  expect(pathsIn('cp "da-archiviare"\\* "storico"')).toEqual(["\\*"])
})

test("in bash a quoted word and the text glued to it are one word, as in the shell", () => {
  expect(pathsIn('rm -f "./già fatti"/*.tmp', "bash")).toEqual([])
  expect(pathsIn('cp "da-archiviare"\\* "storico"', "bash")).toEqual([])
  expect(pathsIn("ls 'my dir'/sub/*.log", "bash")).toEqual([])
  expect(pathsIn('ls "a b"/"c d"/x', "bash")).toEqual([])
  expect(pathsIn('echo "a b" /c', "bash")).toEqual(["/c"])
  expect(pathsIn('echo "a" "/x"', "bash")).toEqual(["/x"])
  expect(pathsIn('echo "a" "/xy"', "bash")).toEqual([])
  // The quotes of another language inside a quoted program are not words of this shell.
  expect(pathsIn('python3 -c "print(\\"/home/user/a b\\")"', "bash")).toEqual(["/home/user/a"])
  // A drive in front of what is glued is still a place.
  expect(pathsIn('ls "/c/Users/x y"/z', "bash")).toEqual(["/c/Users/x y/z"])
})

test("a place of bash that is a drive is written as Windows writes it", () => {
  expect(fromBash("/c/Users/someone/notes.txt")).toBe("C:\\Users\\someone\\notes.txt")
  expect(fromBash("/d")).toBe("D:\\")
  expect(fromBash("/cygdrive/e/data")).toBe("E:\\data")
  expect(fromBash("/mnt/c/Users/x")).toBe("C:\\Users\\x")
  for (const same of ["/tmp/x", "/home/user", "/app", "/", "C:/x", "~", "src/a.txt", "/mnt/data"])
    expect(fromBash(same)).toBe(same)
})

test("what is not a place: a switch, a range of commits, a variable, a relative path", () => {
  const none = [
    "dir /b/s",
    "cmd /c echo hi",
    "git diff HEAD..main",
    "$env:NODE_ENV = 'test'",
    "python src/run.py",
    "git log --format=%H",
    "del /q a.tmp",
    "rmdir /s /q old",
    "dir /b /?",
    'grep "\\.py$" a.txt',
    'printf "\\n\\t"',
    "grep -w '\\bFiore\\b' a.txt",
    "python3 -c \"print('\\nRiva\\n')\"",
    "echo hi 2>/dev/null",
    "echo hi > /dev/stderr",
  ]
  expect(none.flatMap((command) => pathsIn(command))).toEqual([])
})

// ---- running a command

const FOLDER = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-run-"))
afterAll(() => fs.rmSync(FOLDER, { recursive: true, force: true }))
fs.mkdirSync(path.join(FOLDER, "sub dir"), { recursive: true })
fs.writeFileSync(path.join(FOLDER, "notes.txt"), "alpha\nbeta\ngamma\nBeta two\n")
fs.writeFileSync(path.join(FOLDER, "sub dir", "more.txt"), "beta again\n")
fs.writeFileSync(path.join(FOLDER, ".hidden"), "x\n")
const PATH_KEY = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
const without = (pattern: RegExp) => ({
  ...process.env,
  [PATH_KEY]: (process.env[PATH_KEY] ?? "")
    .split(path.delimiter)
    .filter((folder) => !pattern.test(folder))
    .join(path.delimiter),
})
const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
const bash = (command: string, env: Record<string, string | undefined> = process.env) =>
  run({ command, cwd: FOLDER, seconds: 30, shell: "bash", env })

test("bash starts in the folder it is given, and says UTF-8 both ways", async () => {
  expect(await bash("echo città è già")).toEqual({ text: "città è già", code: 0, stopped: false })
  expect((await bash("pwd -W")).text.toLowerCase()).toBe(FOLDER.replaceAll("\\", "/").toLowerCase())
  expect((await bash("cat notes.txt | head -n 2")).text).toBe("alpha\nbeta")
  fs.writeFileSync(path.join(FOLDER, "è.txt"), "perché\n")
  expect((await bash("cat è.txt")).text).toBe("perché")
  expect((await bash("python -c \"print('perché ☕')\"")).text).toBe("perché ☕")
})

test("bash gives the code of the program, and a short error in English without the place of the shell", async () => {
  expect(await bash("echo before; exit 3")).toEqual({ text: "before", code: 3, stopped: false })
  expect(await bash('python -c "import sys; sys.exit(5)"')).toMatchObject({ code: 5 })
  expect(await bash("nothing-here")).toEqual({
    text: "bash: line 1: nothing-here: command not found",
    code: 127,
    stopped: false,
  })
  expect(await bash("ls nothing-here")).toEqual({
    text: "ls: cannot access 'nothing-here': No such file or directory",
    code: 2,
    stopped: false,
  })
  expect(await bash("echo out; echo err >&2")).toMatchObject({ text: "out\nerr", code: 0 })
  expect((await bash("ls --color=always notes.txt")).text).not.toContain("\x1b")
})

test("the commands of Linux a model writes are there, with the programs that come with Git", async () => {
  expect((await bash("ls -la")).text).toContain(".hidden")
  expect(lines((await bash("head -n 2 notes.txt")).text)).toEqual(["alpha", "beta"])
  expect(lines((await bash("tail -n 1 notes.txt")).text)).toEqual(["Beta two"])
  expect(lines((await bash("grep -rn beta .")).text).sort()).toEqual([
    "./notes.txt:2:beta",
    "./sub dir/more.txt:1:beta again",
  ])
  expect(lines((await bash('find . -name "*.txt" -not -name "è.txt"')).text).sort()).toEqual([
    "./notes.txt",
    "./sub dir/more.txt",
  ])
  expect((await bash("wc -l < notes.txt")).text).toBe("4")
  expect((await bash("git log -1 2>/dev/null || echo none")).text).toBe("none")
  expect((await bash("echo hidden >/dev/null; echo shown")).text).toBe("shown")
  // The programs of Git are the shell's own, whatever the PATH of the computer holds.
  const bare = without(/[\\/]git[\\/](usr[\\/])?bin|[\\/]mingw64[\\/]bin/i)
  expect((await bash("ls notes.txt && grep -c beta notes.txt", bare)).text).toBe("notes.txt\n1")
})

test("bash is the one of Git for Windows, never the WSL one that sits first in the PATH", async () => {
  const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")
  const env = { ...process.env, [PATH_KEY]: `${system}${path.delimiter}${process.env[PATH_KEY] ?? ""}` }
  expect((await bash("uname -o; echo $0; which bash", env)).text).toBe("Msys\n/usr/bin/bash\n/usr/bin/bash")
})

test("the bash is the Git for Windows the app carries, otherwise the one installed on the computer", async () => {
  const home = path.join(FOLDER, "resources")
  const empty = path.join(FOLDER, "no programs")
  fs.mkdirSync(path.join(home, "git", "bin"), { recursive: true })
  fs.writeFileSync(path.join(home, "git", "bin", "bash.exe"), "")
  expect(await gitBash({ MANGO_HOME: home, ProgramFiles: empty })).toBe(path.join(home, "git", "bin", "bash.exe"))
  expect(await gitBash({ MANGO_HOME: empty, ProgramFiles: empty })).toBeUndefined()
  const installed = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  expect(await gitBash({ ProgramFiles: process.env.ProgramFiles })).toBe(installed)
  await expect(
    run({ command: "echo hi", cwd: FOLDER, seconds: 30, shell: "bash", env: { ProgramFiles: empty } }),
  ).rejects.toThrow("Git for Windows is not on this computer")
})

test("a path that bash gives to a program of Windows is converted, as Git Bash does by default", async () => {
  const seen = (await bash('python -c "import sys; print(sys.argv[1])" /tmp/x.txt')).text
  // The tests run with a temporary folder of their own: Git Bash maps `/tmp` to the one of the environment it starts in.
  expect(seen).toMatch(/^[A-Za-z]:\/.+\/x\.txt$/)
  expect((await bash('python -c "import sys; print(sys.argv[1])" --flag=/not/a/path')).text).toContain("--flag=")
})

test("what a command prints on its output and on its errors stays on separate lines", async () => {
  expect((await bash("printf out; printf err >&2")).text).toBe("out\nerr")
})

test("bash stops after the seconds it has and says so, with what it had printed", async () => {
  const started = Date.now()
  const ran = await run({ command: "echo started; sleep 30; echo never", cwd: FOLDER, seconds: 2, shell: "bash" })
  expect(ran).toEqual({ text: "started", code: 0, stopped: true })
  expect(Date.now() - started).toBeLessThan(15_000)
}, 30_000)

test("a program a command leaves in the background is stopped when the command ends", async () => {
  const id = "cat /proc/$!/winpid"
  const ran = await run({
    command: `sleep 120 & ${id} > bg.pid; echo serving`,
    cwd: FOLDER,
    seconds: 30,
    shell: "bash",
  })
  expect(ran).toEqual({ text: "serving", code: 0, stopped: false })
  const pid = Number(fs.readFileSync(path.join(FOLDER, "bg.pid"), "utf8"))
  await Bun.sleep(500)
  expect(() => process.kill(pid, 0)).toThrow()
}, 30_000)

test("what a command prints is kept by characters too: the last part, and how much was cut", async () => {
  const one = await bash(String.raw`head -c 100000 /dev/zero | tr '\0' x`)
  expect(one.text).toStartWith("(1 lines, 100000 characters, the last 1 lines)\n")
  expect(one.text.length).toBeLessThan(20_100)
  const many = await bash(String.raw`for i in $(seq 1 150); do printf '%0150d\n' $i; done`)
  expect(many.text.split("\n")[0]).toMatch(/^\(150 lines, 22\d{3} characters, the last 1\d\d lines\)$/)
  expect(many.text.split("\n").at(-1)).toBe(`${"0".repeat(147)}150`)
})

test("a program that prints without end does not fill the memory, and the output is the last part", async () => {
  const ran = await bash(String.raw`head -c 60000000 /dev/zero | tr '\0' y; echo end`)
  expect(ran.text).toMatch(/^\(1 lines, 6\d{7} characters, the last 1 lines\)\n/)
  expect(ran.text.endsWith("yyyyend")).toBe(true)
  expect(ran.text.length).toBeLessThan(20_100)
}, 60_000)

test("bash keeps the last 200 lines of what a command printed", async () => {
  const ran = await bash("seq 1 500")
  const printed = ran.text.split("\n")
  expect([printed[0], printed[1], printed.at(-1), printed.length]).toEqual([
    "(500 lines, the last 200)",
    "301",
    "500",
    201,
  ])
})

// ---- PowerShell, started by default and by the tool `powershell`

const BARE = without(/[\\/]git[\\/](usr[\\/])?bin|[\\/]mingw64[\\/]bin/i)

test("PowerShell is the shell where none is given, and the commands of Linux fail as it has them", async () => {
  const ran = await run({ command: "ls -la", cwd: FOLDER, seconds: 30, env: BARE })
  expect([ran.code, ran.text]).toEqual([1, expect.stringContaining("parameter name 'la'")])
  const head = await run({ command: "head -n 1 notes.txt", cwd: FOLDER, seconds: 30, env: BARE })
  expect([head.code, head.text]).toEqual([1, expect.stringContaining("not recognized")])
})

test("PowerShell answers in one English line, with the code of the program and UTF-8 both ways", async () => {
  const powershell = (command: string) => run({ command, cwd: FOLDER, seconds: 30, shell: "powershell" })
  expect(await powershell("Write-Output 'città è già'")).toEqual({ text: "città è già", code: 0, stopped: false })
  expect(await powershell("Write-Output before; exit 3")).toEqual({ text: "before", code: 3, stopped: false })
  expect(await powershell('python -c "import sys; sys.exit(5)"')).toMatchObject({ code: 5 })
  const failed = await powershell("Get-Item nothing-here.txt")
  expect(failed.code).toBe(1)
  expect(failed.text).toMatch(/^Get-Item: Cannot find path '.*nothing-here\.txt' because it does not exist\.$/)
})

test("PowerShell is Windows PowerShell 5.1: one English line for each error, the program's code, no script in the command line", async () => {
  const powershell = (command: string) => run({ command, cwd: FOLDER, seconds: 30, shell: "powershell" })
  expect((await powershell("$PSVersionTable.PSVersion.Major")).text).toBe("5")
  expect((await powershell("Write-Output a; Get-Item nothing-here.txt; Write-Output b")).text).toMatch(
    /^a\nGet-Item: Cannot find path '.*nothing-here\.txt' because it does not exist\.\nb$/,
  )
  expect(await powershell("throw 'boom'")).toEqual({ text: "boom", code: 1, stopped: false })
  expect(await powershell("Write-Output (")).toEqual({
    text: "An expression was expected after '('. Missing closing ')' in expression.",
    code: 1,
    stopped: false,
  })
  const failing = await powershell(`& '${process.execPath}' -e "console.error('err'); process.exit(5)"`)
  expect([failing.text, failing.code]).toEqual(["err", 5])
  const quiet = await powershell(`& '${process.execPath}' -e "console.error('one'); console.error('two')"`)
  expect([quiet.text, quiet.code]).toEqual(["one\ntwo", 0])
  fs.writeFileSync(path.join(FOLDER, "è.txt"), "perché\n")
  expect((await powershell("Get-Content notes.txt -TotalCount 1; Get-Content è.txt")).text).toBe("alpha\nperché")
  expect((await powershell("'[' + $env:HARNESS_SCRIPT + ']'")).text).toBe("[]")
  expect((await powershell("'a' * 3; 'say \"hi\"'")).text).toBe('aaa\nsay "hi"')
})

test("PowerShell web requests go through the proxy of the environment, except for the hosts it excludes", async () => {
  const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("site is up") })
  try {
    const env = { ...process.env, HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" }
    const get = (address: string) =>
      run({
        command: `(Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 ${address}).Content`,
        cwd: FOLDER,
        seconds: 30,
        shell: "powershell",
        env,
      })
    const away = await get("http://example.invalid/")
    expect([away.code, away.text.includes("example.invalid")]).toEqual([1, false])
    expect(await get(`http://127.0.0.1:${site.port}/`)).toEqual({ text: "site is up", code: 0, stopped: false })
  } finally {
    site.stop(true)
  }
})

test("a PowerShell script gets the user's environment, without the keys the app gives the agent", async () => {
  const ran = await run({
    command: '"[$env:MANGO_TEST_VISIBLE][$env:MANGO_SERVER_KEY_SERVER_1][$env:MANGO_ENGINE_KEY]"',
    cwd: FOLDER,
    seconds: 30,
    shell: "powershell",
    env: {
      ...process.env,
      MANGO_SERVER_KEY_SERVER_1: "s3cret",
      MANGO_ENGINE_KEY: "s3cret",
      MANGO_TEST_VISIBLE: "kept",
    },
  })
  expect(ran.text).toBe("[kept][][]")
})

test("escape sequences of printf and echo are text, not places", () => {
  expect(pathsIn(String.raw`printf '\xff\xfe' > out.txt`, "bash")).toEqual([])
  expect(pathsIn(String.raw`printf '\377\376\x41' > out.txt`, "bash")).toEqual([])
  expect(pathsIn(String.raw`echo -e 'è\t\x20'`, "bash")).toEqual([])
  expect(pathsIn(String.raw`cat '\Windows\System32\drivers\etc\hosts'`, "bash")).toEqual([
    String.raw`\Windows\System32\drivers\etc\hosts`,
  ])
})

import { describe, expect, test } from "bun:test"
import { BashHabits } from "../../src/tool/shell/bash-habits"

describe("BashHabits.chain", () => {
  test("turns a chain into nested conditions", () => {
    expect(BashHabits.chain("cd mail && bun test-import.mjs")).toBe("cd mail; if ($?) { bun test-import.mjs }")
    expect(BashHabits.chain("git add . && git commit -m x && git push")).toBe(
      "git add .; if ($?) { git commit -m x; if ($?) { git push } }",
    )
  })

  test("rewrites only the statement that has the chain", () => {
    expect(BashHabits.chain("echo one; cd src && bun x.ts 2>&1; echo three")).toBe(
      "echo one;cd src; if ($?) { bun x.ts 2>&1 }; echo three",
    )
    expect(BashHabits.chain("cd src && bun x.ts\necho done")).toBe("cd src; if ($?) { bun x.ts }\necho done")
  })

  test("keeps a pipeline inside its side of the chain", () => {
    expect(BashHabits.chain("git status | Select-String M && echo dirty")).toBe(
      "git status | Select-String M; if ($?) { echo dirty }",
    )
  })

  test("leaves text inside strings alone", () => {
    for (const command of [
      `echo "a && b"`,
      `echo 'a && b'`,
      `bun -e "if (a && b) console.log(1)"`,
      "$text = @'\na && b\n'@\necho $text",
      "echo a `&& b",
    ])
      expect(BashHabits.chain(command)).toBe(command)
    expect(BashHabits.chain(`cd src && bun -e "if (a && b) console.log(1)"`)).toBe(
      `cd src; if ($?) { bun -e "if (a && b) console.log(1)" }`,
    )
  })

  test("returns what it cannot rewrite safely as it is", () => {
    for (const command of [
      "echo a || echo b",
      "cd src && bun x.ts || echo failed",
      "if ($true) { cd src && bun x.ts }",
      "cd src && bun x.ts # run it",
      "cd src &&",
      "cd src &&\nbun x.ts",
      `cd src && echo "open string`,
      "echo plain",
    ])
      expect(BashHabits.chain(command)).toBe(command)
  })
})

describe("BashHabits.notes", () => {
  const notes = (command: string, shell = "powershell", present: string[] = []) =>
    BashHabits.notes({ command, shell, missing: (name) => !present.includes(name) })

  test("says nothing about a command written for PowerShell", () => {
    expect(notes("Get-Content file.txt | Select-String name; bun test.mjs 2>&1")).toEqual([])
    expect(notes("cd src; if ($?) { bun x.ts }")).toEqual([])
    expect(notes(`echo "head of the list << here && there"`)).toEqual([])
  })

  test("names the bash commands this computer does not have, and what to use instead", () => {
    const [note, ...rest] = notes("head -100 gmail.js | tail -50")
    expect(rest).toEqual([])
    expect(note).toContain("Windows PowerShell (5.1), not bash")
    expect(note).toContain("`head`, `tail` do not exist on this computer")
    expect(note).toContain("Read tool")
    expect(notes("export FOO=1", "pwsh")[0]).toContain('`export` does not exist on this computer. Instead: set a variable with `$env:NAME = "value"`')
    expect(notes("export FOO=1", "pwsh")[0]).toContain("This shell is PowerShell, not bash")
  })

  test("says nothing about a bash command that is installed", () => {
    expect(notes("git log --oneline | head -5", "pwsh", ["head"])).toEqual([])
    expect(notes("git log --oneline | head -5", "pwsh")).toHaveLength(1)
  })

  test("does not take an argument for a command", () => {
    expect(notes("echo head; git grep tail; Get-Command which")).toEqual([])
  })

  test("explains a heredoc", () => {
    const list = notes("cat > test-import.mjs << 'EOF'\nconsole.log(1)\nEOF", "pwsh", ["cat"])
    expect(list).toHaveLength(1)
    expect(list[0]).toContain("no heredoc")
    expect(list[0]).toContain("Write tool")
  })

  test("explains a chain that is still there, only where the shell has none", () => {
    expect(notes("echo a || echo b")[0]).toContain("no `&&` and no `||`")
    expect(notes("if ($true) { cd src && bun x.ts }")[0]).toContain("cmd1; if ($?) { cmd2 }")
    expect(notes("echo a || echo b", "pwsh")).toEqual([])
  })

  test("names the commands that only bash has, and the `find` that is another program here", () => {
    expect(notes("wc -l style.css", "pwsh")[0]).toContain("(Get-Content file).Count")
    expect(notes("pkill -f server; lsof -i :3000", "pwsh")[0]).toContain("`pkill`, `lsof` do not exist on this computer")
    expect(notes("find . -name '*.js'", "pwsh")[0]).toContain("Glob tool")
    expect(notes('find "text" file.txt', "pwsh")).toEqual([])
  })
})

describe("BashHabits.adapt", () => {
  const project = "C:\\Users\\name\\Desktop\\bike-shop"
  const adapt = (command: string, present = ["python"]) =>
    BashHabits.adapt({ command, directory: project, missing: (name) => !present.includes(name) })
  const run = (command: string, present?: string[]) => adapt(command, present).command

  test("leaves a command written for PowerShell as it is", () => {
    for (const command of ["Get-ChildItem -Force", "cmd /c dir", "findstr /s /i text *.js", "bun test 2>&1", "curl http://localhost:3000/home/page"])
      expect(adapt(command)).toEqual({ command, notes: [] })
  })

  test("sends output to PowerShell's null device", () => {
    expect(run("bun x.ts 2>/dev/null")).toBe("bun x.ts 2>$null")
    expect(run("bun x.ts > /dev/null 2>&1")).toBe("bun x.ts >$null 2>&1")
    expect(run("bun x.ts &>/dev/null")).toBe("bun x.ts *>$null")
    expect(run("curl -s -o /dev/null http://localhost:3000")).toBe("curl -s -o NUL http://localhost:3000")
  })

  test("runs the PowerShell command that does the same job", () => {
    expect(run("ls -la")).toBe("Get-ChildItem -Force")
    expect(run("cd site && ls -l css")).toBe("cd site && Get-ChildItem -Force css")
    expect(run("ps aux")).toBe("Get-Process")
    expect(run("rm -rf dist")).toBe("Remove-Item -Recurse -Force dist")
    expect(run("kill -9 4242")).toBe("Stop-Process -Force -Id 4242")
    expect(run("mkdir -p css/img")).toBe("New-Item -ItemType Directory -Force -Path css/img | Out-Null")
    expect(run("python3 -m http.server")).toBe("python -m http.server")
    expect(run("python3 x.py", ["python", "python3"])).toBe("python3 x.py")
    expect(run("python3 x.py", [])).toBe("python3 x.py")
  })

  test("takes a Unix path from the project folder, and says so", () => {
    const got = adapt("ls -la /home/user/bike-shop/")
    expect(got.command).toBe("Get-ChildItem -Force C:/Users/name/Desktop/bike-shop")
    expect(got.notes[0]).toContain("`/home/user/bike-shop/` is not a path here")
    expect(run("cat /tmp/server.log")).toBe("cat C:/Users/name/Desktop/bike-shop/server.log")
    expect(run("python -c \"import os; os.chdir('/home/user/bike-shop')\"")).toBe(
      "python -c \"import os; os.chdir('C:/Users/name/Desktop/bike-shop')\"",
    )
  })

  test("turns a drive written the Git Bash way into the drive", () => {
    expect(run("cd /c/Users/name/Desktop/bike-shop && ls -la")).toBe("cd C:/Users/name/Desktop/bike-shop && Get-ChildItem -Force")
    expect(run('cd "/c/Users/name/Documents" && pwd')).toBe('cd "C:/Users/name/Documents" && pwd')
    expect(run("ls -la /C:/Users/name/Desktop/bike-shop/")).toBe("Get-ChildItem -Force C:/Users/name/Desktop/bike-shop/")
    expect(adapt("cd /c/Users/name/Documents").notes).toEqual([])
    expect(run("cmd /c dir")).toBe("cmd /c dir")
  })

  test("lists several names at once", () => {
    expect(run("ls -lh *.html *.css *.js")).toBe("Get-ChildItem -Force *.html,*.css,*.js")
    expect(run("cd site && ls -la a b; echo done")).toBe("cd site && Get-ChildItem -Force a,b; echo done")
  })

  test("keeps a quoted name with spaces whole", () => {
    expect(run(`ls -la "old photos"`)).toBe(`Get-ChildItem -Force "old photos"`)
    expect(run(`ls -la "old photos" 'new photos' css`)).toBe(`Get-ChildItem -Force "old photos",'new photos',css`)
  })

  test("ends a pipeline with PowerShell's own filter", () => {
    expect(run(`pip list 2>/dev/null | grep -iE "diffusers|torch"`)).toBe(`pip list 2>$null | Select-String -Pattern "diffusers|torch"`)
    expect(run("git log --oneline | head -5")).toBe("git log --oneline | Select-Object -First 5")
    expect(run("git log --oneline | tail -n 3 | wc -l")).toBe("git log --oneline | Select-Object -Last 3 | Measure-Object -Line | ForEach-Object Lines")
    expect(run(`bun test 2>&1 | grep -v pass | head`)).toBe("bun test 2>&1 | Select-String -NotMatch -CaseSensitive -Pattern pass | Select-Object -First 10")
    expect(run(`Get-Process | grep "a\\|b"`)).toBe(`Get-Process | Select-String -CaseSensitive -Pattern "a|b"`)
    expect(run("cd site && git status | grep modified; echo done")).toBe("cd site && git status | Select-String -CaseSensitive -Pattern modified; echo done")
  })

  test("leaves a filter it has no counterpart for, or that this computer has, as written", () => {
    for (const command of ["git log | grep -c fix", "git log | grep -A2 fix", "grep -rn word src", "head -5 notes.txt"])
      expect(run(command)).toBe(command)
    expect(run("git log --oneline | head -5", ["python", "head"])).toBe("git log --oneline | head -5")
  })

  test("leaves alone a path that may be an address of a site, not a folder", () => {
    for (const command of [`bun -e "fetch('/api/items')"`, `bun -e "app.get('/app/users', list)"`, "curl http://localhost:3000/home/user/page"])
      expect(adapt(command)).toEqual({ command, notes: [] })
  })

  test("leaves a program running the way PowerShell does", () => {
    expect(run("python3 -m http.server 8080 --bind 127.0.0.1 &")).toBe(
      "Start-Process -WindowStyle Hidden python -ArgumentList '-m http.server 8080 --bind 127.0.0.1'",
    )
    expect(run("cd /home/user/bike-shop && python3 -m http.server 8080 > /dev/null 2>&1 &\necho started")).toBe(
      "Start-Process -WindowStyle Hidden python -ArgumentList '-m http.server 8080' -WorkingDirectory C:/Users/name/Desktop/bike-shop\necho started",
    )
    expect(adapt("bun dev &").notes).toEqual([])
  })

  test("says that a job it cannot rewrite stops with the call", () => {
    const got = adapt('bun -e "serve()" > out.log &')
    expect(got.command).toBe('bun -e "serve()" > out.log &')
    expect(got.notes[0]).toContain("the program is not running")
    expect(adapt("cd src && bun x.ts").notes).toEqual([])
  })
})

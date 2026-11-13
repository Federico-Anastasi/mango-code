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
})

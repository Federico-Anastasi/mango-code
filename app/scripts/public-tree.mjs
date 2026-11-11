// Builds the public tree of a Mango app from the private repo: the committed tree of a ref minus the private files,
// which are the paths marked `export-ignore` in the repo's .gitattributes (the one list, the one `git archive` obeys).
// It stops before any commit or push: it prints what it found and the commands that would follow. Copy it into each repo.
// Usage: node <this file> [--ref HEAD] [--out <empty or missing folder>] [--base <git repo of the public tree>] [--base-ref <ref in it>]
//   --base: the repo whose last commit is the previous public one (default: this repo); --base-ref: default public-release.
//   The public clone of Mango Animation is `--base ../mango-animation-pubblico --base-ref HEAD`.
// Exits with 1 when a private path is still in the tree or a file carries something that must not be public.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 })
const repo = git(process.cwd(), "rev-parse", "--show-toplevel").trim()
const ref = arg("ref", "HEAD")
const base = path.resolve(arg("base", repo))
const baseRef = arg("base-ref", "public-release")
const out = path.resolve(arg("out", path.join(os.tmpdir(), `albero-pubblico-${path.basename(repo)}`)))

// What must not be in a public tree: the maintainer's paths and credentials. Fake data in tests uses other names.
const FORBIDDEN = [
  [/Dev_F[A]/, "path of the maintainer's PC"],
  [/Users[\\/]+Mango\b/, "user name of the maintainer's PC"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b(?:sk-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sntry[su]_[A-Za-z0-9]{20,})/, "token"],
]

// Tokens made up for the tests of the anonymization (the standard asks for them): runs like 0123456789 or abcdefghij.
const INVENTED = /0123456789|abcdefghij|ABCDEFGH|xxxxxxxx|EXAMPLE/

// Keys made for a test and good for nothing else, each with where its story is told.
const TEST_KEYS = new Set([
  // the certificate of the fake company filter, for downloads.example.test, from a root whose key was thrown away (internet/fake_proxy.rs)
  "app/crates/mango-common/src/internet/leaf-key.pem",
])

const attributes = git(repo, "show", `${ref}:.gitattributes`)
const privatePaths = attributes.split("\n").filter((l) => /\sexport-ignore\b/.test(l)).map((l) => l.trim().split(/\s+/)[0].replace(/\/$/, ""))
if (!privatePaths.length) throw new Error(`${ref}:.gitattributes marks no path export-ignore: the list of private files is empty`)
if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} is not empty: choose another --out`)

fs.mkdirSync(out, { recursive: true })
// through a file beside the folder: a pipe of hundreds of MB between the two programs stalls on Windows
const archive = `${out}.tar`
execFileSync("git", ["-c", "core.autocrlf=false", "archive", "-o", archive, ref], { cwd: repo })
execFileSync("tar", ["-x", "-f", path.relative(out, archive).split(path.sep).join("/")], { cwd: out })
fs.rmSync(archive)

const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else files.push(path.relative(out, p).split(path.sep).join("/"))
  }
}
walk(out)

const problems = []
for (const p of privatePaths) if (files.some((f) => f === p || f.startsWith(`${p}/`))) problems.push(`${p}: private, but in the tree`)
for (const f of files) {
  const full = path.join(out, f)
  if (fs.statSync(full).size > 2 << 20) continue
  const text = fs.readFileSync(full)
  if (text.includes(0)) continue
  const content = text.toString("utf8")
  for (const [pattern, why] of FORBIDDEN) {
    for (const match of content.matchAll(new RegExp(pattern, "g"))) {
      if (why === "token" && INVENTED.test(match[0])) continue
      if (why === "private key" && TEST_KEYS.has(f)) continue
      problems.push(`${f}: ${why}`)
      break
    }
  }
}

// Against the previous public commit: what the new one adds, changes and removes.
const before = new Map(git(base, "ls-tree", "-r", baseRef).split("\n").filter(Boolean).map((l) => [l.split("\t")[1], l.split(/\s/)[2]]))
const hashed = execFileSync("git", ["hash-object", "--no-filters", "--stdin-paths"], { cwd: out, input: files.join("\n"), encoding: "utf8", maxBuffer: 1 << 30 }).split("\n")
const after = new Map(files.map((f, i) => [f, hashed[i]]))
const added = files.filter((f) => !before.has(f))
const changed = files.filter((f) => before.has(f) && before.get(f) !== after.get(f))
const removed = [...before.keys()].filter((f) => !after.has(f))
const show = (title, list) => console.log(`${title}: ${list.length}${list.length ? `\n  ${list.slice(0, 15).join("\n  ")}${list.length > 15 ? "\n  …" : ""}` : ""}`)

console.log(`Public tree of ${ref} in ${out}: ${files.length} files, without ${privatePaths.join(", ")}.`)
show("Added", added)
show("Changed", changed)
show("Removed", removed)
if (problems.length) {
  console.error(`\nNot publishable:\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
const email = "109090424+Federico-Anastasi@users.noreply.github.com"
console.log(`
Nothing was committed or pushed. After reading the lists above, with the noreply identity (GIT_AUTHOR_* and GIT_COMMITTER_* = Federico Anastasi <${email}>):
  tree:    GIT_INDEX_FILE=<a new file> git -C ${base} --work-tree=${out} add -A && git -C ${base} write-tree
  commit:  git -C ${base} commit-tree <tree> -p ${baseRef} -m "<product> <version>"
  branch:  git -C ${base} update-ref refs/heads/<branch> <commit>  (a public clone: then git reset --hard there)
  tag:     git -C ${base} tag v<version> <commit>   (not annotated)
  push:    git -C ${base} push <public remote> <branch> v<version>`)

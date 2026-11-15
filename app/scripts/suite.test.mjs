// `suite/` is the same folder in every Mango app (colours, typefaces, marks): node --test app/scripts/suite.test.mjs
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const suite = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "suite")
// Whoever changes the folder changes it in every app, and only then writes the new fingerprint here.
const FINGERPRINT = "40eebf7cb49748ed2d3e62390d91ebc6c88c397f5396dadd7176df767219ea68"
const TEXT = /\.(css|svg|txt|md)$/

test("suite/ is as it was written the last time it changed in every app", () => {
  const hash = createHash("sha256")
  const files = fs
    .readdirSync(suite, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name).slice(suite.length + 1).replaceAll("\\", "/"))
    .sort()
  for (const name of files) {
    const content = fs.readFileSync(path.join(suite, name))
    // A text file has the same fingerprint with Windows line ends and with Linux ones.
    hash.update(`${name}\n`).update(TEXT.test(name) ? content.toString("utf8").replaceAll("\r\n", "\n") : content)
  }
  assert.equal(hash.digest("hex"), FINGERPRINT)
})

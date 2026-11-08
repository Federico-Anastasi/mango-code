// Checks the installer's update signature (.sig) against the public key in tauri.conf.json, before a release is
// published: an installer signed with another key, or changed after signing, would never be installed by the app.
// Usage: node scripts/verify-signature.mjs   (the installer that build.ps1 left in target/release/bundle/nsis)
// Exits with 1 when the signature is not valid.
import { createHash, createPublicKey, verify } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const nsis = path.join(app, "target", "release", "bundle", "nsis")
const installers = fs.readdirSync(nsis).filter((f) => f.endsWith("-setup.exe"))
if (installers.length !== 1) throw new Error(`one installer expected in ${nsis}, found: ${installers.join(", ") || "none"}`)
const exe = path.join(nsis, installers[0])

// minisign format, base64 inside base64: a comment line, then 2 bytes of algorithm, 8 of key id and the key or the
// signature; the .sig adds the trusted comment and its own signature.
const lines = (s) => Buffer.from(s.trim(), "base64").toString("utf8").split("\n")
const conf = JSON.parse(fs.readFileSync(path.join(app, "src-tauri", "tauri.conf.json"), "utf8"))
const pub = Buffer.from(lines(conf.plugins.updater.pubkey)[1], "base64")
const sig = lines(fs.readFileSync(`${exe}.sig`, "utf8"))
const signature = Buffer.from(sig[1], "base64")
if (!pub.subarray(2, 10).equals(signature.subarray(2, 10))) {
  console.error(`${exe}.sig was made with another key than the one in tauri.conf.json`)
  process.exit(1)
}
const key = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.subarray(10)]),
  format: "der",
  type: "spki",
})
const data = fs.readFileSync(exe)
// "ED": signature of the file's BLAKE2b-512 hash (what Tauri writes); "Ed": of the file itself.
const message = signature.subarray(0, 2).toString() === "ED" ? createHash("blake2b512").update(data).digest() : data
const onFile = verify(null, message, key, signature.subarray(10))
const trusted = Buffer.from(sig[2].replace("trusted comment: ", ""))
const onComment = verify(null, Buffer.concat([signature.subarray(10), trusted]), key, Buffer.from(sig[3], "base64"))
console.log(`${installers[0]}: signature ${onFile ? "valid" : "NOT VALID"}, trusted comment ${onComment ? "valid" : "NOT VALID"}`)
if (!onFile || !onComment) process.exit(1)

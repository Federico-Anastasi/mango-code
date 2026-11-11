// Verifies a Tauri updater signature (.sig) against the pubkey in tauri.conf.json, before publishing a release.
// Usage: node app/scripts/verify-signature.mjs <installer.exe> <installer.exe.sig> <tauri.conf.json>
// Exits with 1 if the signature (on the file or the trusted comment) is not valid. Copy it into each app's repo.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const [exe, sigFile, confFile] = process.argv.slice(2);
if (!confFile) throw new Error("usage: node app/scripts/verify-signature.mjs <installer> <installer.sig> <tauri.conf.json>");
const lines = (s) => Buffer.from(s.trim(), "base64").toString("utf8").split("\n");
const pub = lines(JSON.parse(readFileSync(confFile, "utf8")).plugins.updater.pubkey);
const sig = lines(readFileSync(sigFile, "utf8"));
const pk = Buffer.from(pub[1], "base64");
const sg = Buffer.from(sig[1], "base64");
// minisign: 2 bytes algorithm, 8 bytes key id, then the key or the signature.
if (!pk.subarray(2, 10).equals(sg.subarray(2, 10))) throw new Error("the .sig was made with another key");
const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.subarray(10)]), format: "der", type: "spki" });
const data = readFileSync(exe);
// "ED" = signature of the file's BLAKE2b-512 hash (what Tauri writes), "Ed" = of the file itself.
const message = sg.subarray(0, 2).toString() === "ED" ? createHash("blake2b512").update(data).digest() : data;
const onFile = verify(null, message, key, sg.subarray(10));
const trusted = sig[2].replace("trusted comment: ", "");
const onComment = verify(null, Buffer.concat([sg.subarray(10), Buffer.from(trusted)]), key, Buffer.from(sig[3], "base64"));
console.log(`signature on the file: ${onFile ? "valid" : "INVALID"}; on the trusted comment: ${onComment ? "valid" : "INVALID"}`);
if (!onFile || !onComment) process.exit(1);

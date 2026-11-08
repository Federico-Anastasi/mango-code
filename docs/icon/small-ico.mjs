// Composes icon.ico: sizes up to 32 px come from the icon for small sizes, the others from the full one.
// Usage: node small-ico.mjs <full-ico> <small-ico> <output>
import fs from "node:fs";

const levels = (file) => {
  const b = fs.readFileSync(file);
  return Array.from({ length: b.readUInt16LE(4) }, (_, i) => {
    const o = 6 + 16 * i;
    return { size: b[o] || 256, entry: b.subarray(o, o + 16), data: b.subarray(b.readUInt32LE(o + 12), b.readUInt32LE(o + 12) + b.readUInt32LE(o + 8)) };
  });
};

const [full, small, output] = process.argv.slice(2);
const chosen = new Map(levels(full).map((l) => [l.size, l]));
for (const l of levels(small)) if (l.size <= 32) chosen.set(l.size, l);
const list = [...chosen.values()].sort((a, b) => a.size - b.size);

const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(list.length, 4);
let offset = 6 + 16 * list.length;
const entries = list.map((l) => {
  const e = Buffer.from(l.entry);
  e.writeUInt32LE(l.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += l.data.length;
  return e;
});
fs.writeFileSync(output, Buffer.concat([header, ...entries, ...list.map((l) => l.data)]));
console.log(`${output}: ${list.map((l) => l.size).join(" ")}`);

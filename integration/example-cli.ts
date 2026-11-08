// A session with Mango Code from the command line: finds it (or starts it without a window), opens a
// session on the folder and prints the answer as it arrives, with the tools called.
//
// Usage: bun integration/example-cli.ts <folder> "<message>" [model]

import { launch, MangoCode } from "./client/mango-code";

const [directory, message, model] = process.argv.slice(2);
if (!directory || !message) {
  console.error('usage: bun integration/example-cli.ts <folder> "<message>" [model]');
  process.exit(2);
}
const mc = new MangoCode(await launch());
const id = await mc.createSession(directory, { title: message.slice(0, 40) });
for await (const s of mc.turn(id, directory, message, { model })) {
  if (s.type === "text") process.stdout.write(s.delta);
  else if (s.type === "tool" && s.status === "completed") process.stdout.write(`\n[${s.name}]\n`);
  else if (s.type === "tool" && s.status === "error") process.stdout.write(`\n[${s.name}: ${s.error}]\n`);
  else if (s.type === "permission") await mc.replyPermission(directory, s.id, "once");
  else if (s.type === "question") await mc.rejectQuestion(directory, s.id);
  else if (s.type === "error") console.error(`\nerror: ${JSON.stringify(s.error)}`);
}
process.stdout.write(`\n(session ${id})\n`);

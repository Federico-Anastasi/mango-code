// What the user stopped stays stopped. A Team conversation with the real window and the real agent (fake local engine, fake
// cloud, see team-world.ts): the manager starts the dev, which speaks for a long time, and an agent. Then
//  - the user turns the Team switch off: the dev and the agent end at once, nothing more reaches the engines, and the
//    conversation says in one line that the Team was stopped;
//  - the app restarts the agent (the Team's choices are saved) while the dev works: the dev does not go on, and says so;
//  - the user removes the key while the manager is answering: the answer is cut, the dev and the agent end, the app starts
//    again without the Team and the conversation says it.
// Each test has its own app. The pictures go to the folder `MANGO_TEST_SCREENSHOTS` names.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveScreenshot } from "./environment";
import { alive, completions, followWindow, hiddenPid, mouseClick, startWorld, stopWorld, textOf, until, write, type World } from "./team-world";

const START = "ZZ-START-ZZ";
const WORK = "ZZ-WORK-ZZ";
const LONG = "ZZ-LONG-ZZ";
const SWITCH = '[data-action="prompt-team"] [role="switch"]';

let world: World;

const photo = async (name: string) => saveScreenshot(world.env, name, (await world.p.send("Page.captureScreenshot", { format: "png" })).result.data);
const devRequests = () => completions(world.env.engineLog).filter((r) => JSON.stringify(r.body.messages).includes(WORK)).length;
const managerRequests = () => completions(world.cloudLog).filter((r) => JSON.stringify(r.body.messages).includes(START)).length;
const notices = () => textOf(world, '[data-timeline-row="TeamNotice"]');

/** A new conversation with the Team switch on, the task sent, the manager has started the dev and an agent and the dev is speaking. */
async function teamAtWork() {
  await until("the button of a new conversation", () => world.p.evaluate(`!!document.querySelector('[aria-label="Nuova conversazione"]')`));
  await mouseClick(world, '[aria-label="Nuova conversazione"]');
  await until("the composer", () => world.p.evaluate(`!!document.querySelector('[contenteditable="true"]')`));
  await until("the Team switch", () => world.p.evaluate(`!!document.querySelector(${JSON.stringify(SWITCH)})`));
  await mouseClick(world, SWITCH);
  await until("the switch on", () => world.p.evaluate(`document.querySelector(${JSON.stringify(SWITCH)})?.getAttribute("aria-checked") === "true"`));
  await write(world, START);
  const dev = await until("the dev started", () => hiddenPid(world, "dev"));
  const agent = await until("agent 1 started", () => hiddenPid(world, "agents/agent-1"));
  const before = devRequests();
  await until("the dev at work", () => devRequests() > before || before > 0);
  return { dev, agent };
}

beforeEach(async () => {
  world = await startWorld(
    [{ summary: "A title" }, { if: WORK, text: "dev ".repeat(100) }, { text: "ready" }],
    [
      { summary: "A title" },
      { if: "You are AGENT 1", text: "Agent 1 is ready." },
      { if: LONG, text: "manager ".repeat(400) },
      { tool: "ask_dev", arguments: { instruction: WORK }, also: [{ tool: "launch_agent", arguments: { agent: "1" } }] },
      { text: "Both are working." },
    ],
    { agents: 1, chunkMs: 200 },
  );
}, 300_000);

afterEach(() => stopWorld(world));

test("turning the Team off ends the dev and the agent at once, and the conversation says so", async () => {
  const { dev, agent } = await teamAtWork();
  await until("the manager's answer", async () => (await textOf(world, '[data-component="text-part"]')).includes("Both are working."));
  await photo("10-team-working");
  const before = [devRequests(), managerRequests()];

  await mouseClick(world, SWITCH);

  await until("the dev and the agent ended", () => !alive(dev) && !alive(agent), 20_000);
  await until("the line in the conversation", async () => (await notices()).includes("Team fermato"), 20_000);
  expect(await world.p.evaluate(`document.querySelector(${JSON.stringify(SWITCH)})?.getAttribute("aria-checked")`)).toBe("false");
  await photo("11-team-switched-off");
  await Bun.sleep(3000);
  expect(devRequests()).toBeLessThanOrEqual(before[0] + 1);
  expect(managerRequests()).toBe(before[1]);
  expect(fs.existsSync(path.join(world.env.data, "team", "dev.pid"))).toBe(false);
}, 180_000);

test("the app restarting the agent does not leave the dev working, and says it", async () => {
  const { dev, agent } = await teamAtWork();
  await until("the manager's answer", async () => (await textOf(world, '[data-component="text-part"]')).split("Both are working.").length > 2);
  const service = path.join(world.env.data, "service.json");
  const written = fs.statSync(service).mtimeMs;

  await world.bridge('save(1, "cloudfake", "cloudfake")');

  await until("the agent restarted", () => fs.existsSync(service) && fs.statSync(service).mtimeMs > written, 120_000);
  await followWindow(world);
  await until("the dev and the agent ended", () => !alive(dev) && !alive(agent), 20_000);
  await until("the line in the conversation", async () => (await notices()).includes("Team fermato"), 60_000);
  await photo("12-restart-ends-the-team");
}, 240_000);

test("removing the key while the manager answers cuts the answer, ends the dev and the agent and says it", async () => {
  const { dev, agent } = await teamAtWork();
  await write(world, LONG);
  await until("the manager's long answer", () => managerRequests() > 0 && textOf(world, '[data-component="text-part"]').then((t) => t.includes("manager manager")));
  const service = path.join(world.env.data, "service.json");
  const written = fs.statSync(service).mtimeMs;
  const conversation = await world.p.evaluate("location.pathname + location.search");
  await world.p.evaluate(`window.dispatchEvent(new CustomEvent("mango-settings", { detail: { section: "links" } }))`);
  await until("the cloud card", () => world.p.evaluate(`!!document.querySelector('[data-action="settings-cloud-open"]')`));
  await mouseClick(world, '[data-action="settings-cloud-open"]');
  await until("the Team settings", () => world.p.evaluate(`!!document.querySelector('[data-action="settings-team-key"] button')`));
  await photo("13-key-removal-asked");

  await mouseClick(world, '[data-action="settings-team-key"] button');

  await until("the dev and the agent ended", () => !alive(dev) && !alive(agent), 20_000);
  await until("the agent restarted", () => fs.existsSync(service) && fs.statSync(service).mtimeMs > written, 120_000);
  await followWindow(world);
  expect((await world.bridge("info()")).key).toBe(false);
  await world.p.evaluate(`location.href = ${JSON.stringify(world.env.agent + conversation)}`);
  await until("the line in the conversation", async () => (await notices()).includes("Team fermato"), 60_000);
  await photo("14-key-removed-team-stopped");
}, 300_000);

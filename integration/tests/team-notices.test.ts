// What the dev and the agents write to the manager is the Team's, not the user's. A Team conversation with the real window
// and the real agent (fake local engine, fake cloud, see team-world.ts): the manager starts the dev and an agent. The dev
// answers with a message to the manager; the agent ends its turn without one, so the Team writes the manager an automatic
// notice. The conversation shows a line for each, and the only message shown as the user's is the one the user wrote.
// The line shows the beginning of the message; a click of the mouse opens the whole of it, rendered as Markdown like a message of the conversation, and a second one closes it.
// The pictures go to the folder `MANGO_TEST_SCREENSHOTS` names.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { saveScreenshot } from "./environment";
import { mouseClick, startWorld, stopWorld, textOf, until, write, type World } from "./team-world";

const START = "ZZ-START-ZZ";
const REPORT = "ZZ-REPORT-ZZ";
const MESSAGE = `**The report** is written.\nSecond line of the report. ${"word ".repeat(40)}ZZ-TAIL-ZZ`;
const DEV_LINE = '[data-component="team-notice"][data-kind="report"]';
const AUTOMATIC_LINE = '[data-component="team-notice"][data-kind="automatic"]';
const SWITCH = '[data-action="prompt-team"] [role="switch"]';

let world: World;

beforeAll(async () => {
  world = await startWorld(
    [
      { summary: "A title" },
      { if: "Message sent to the manager", text: "Sent to the manager." },
      { if: REPORT, tool: "ask_manager", arguments: { message: MESSAGE } },
      { text: "ready" },
    ],
    [
      { summary: "A title" },
      { if: "You are AGENT 1", text: "Agent 1 is ready." },
      { tool: "ask_dev", arguments: { instruction: REPORT }, also: [{ tool: "launch_agent", arguments: { agent: "1" } }] },
      { text: "Both are working." },
    ],
    { agents: 1 },
  );
}, 300_000);

afterAll(() => stopWorld(world));

test("the messages of the dev and of the agents show as lines of the Team, never as the user's message", async () => {
  await until("the button of a new conversation", () => world.p.evaluate(`!!document.querySelector('[aria-label="Nuova conversazione"]')`));
  await mouseClick(world, '[aria-label="Nuova conversazione"]');
  await until("the Team switch", () => world.p.evaluate(`!!document.querySelector(${JSON.stringify(SWITCH)})`));
  await mouseClick(world, SWITCH);
  await until("the switch on", () => world.p.evaluate(`document.querySelector(${JSON.stringify(SWITCH)})?.getAttribute("aria-checked") === "true"`));
  await write(world, START);

  const notices = () => textOf(world, '[data-timeline-row="TeamNotice"]');
  await until("the line of the dev's message", async () => (await notices()).includes("Il dev ha scritto al manager"), 120_000);
  await until("the line of the agent's automatic notice", async () => (await notices()).includes("L'agente 1 ha finito senza scrivere al manager"), 120_000);

  const users = await world.p.evaluate(`[...document.querySelectorAll('[data-timeline-row="UserMessage"]')].map((el) => el.textContent)`);
  expect(users).toHaveLength(1);
  expect(users[0]).toStartWith(START);
  expect(await notices()).not.toContain("coordinatore");
  expect(await textOf(world, "body")).not.toContain("automatic: turn ended");

  // closed: the beginning of the message after the words, on one line, cut; the rest is not on the page
  const trigger = `${DEV_LINE} button`;
  const expanded = () => world.p.evaluate(`document.querySelector(${JSON.stringify(trigger)})?.getAttribute("aria-expanded")`);
  const body = () => world.p.evaluate(`document.querySelector(${JSON.stringify(`${DEV_LINE} [data-slot="team-notice-body"]`)})?.textContent ?? null`);
  const excerpt = await textOf(world, `${DEV_LINE} [data-slot="team-notice-excerpt"]`);
  expect(excerpt).toStartWith("The report is written. Second line of the report. word word");
  expect(excerpt).toEndWith("…");
  expect(await textOf(world, DEV_LINE)).toStartWith("Il dev ha scritto al manager");
  expect(await expanded()).toBe("false");
  expect(await body()).toBeNull();
  expect(await textOf(world, "body")).not.toContain("ZZ-TAIL-ZZ");
  saveScreenshot(world.env, "20-team-lines", (await world.p.send("Page.captureScreenshot", { format: "png" })).result.data);

  // a click of the mouse opens the whole message, rendered as the conversation renders a message, with no label of the plugin
  await mouseClick(world, trigger);
  await until("the line open", async () => (await expanded()) === "true");
  await until("the message rendered", () => world.p.evaluate(`!!document.querySelector(${JSON.stringify(`${DEV_LINE} [data-slot="team-notice-body"] strong`)})`));
  const opened = await body();
  expect(opened).toContain("ZZ-TAIL-ZZ");
  expect(opened).not.toContain("**");
  expect(await textOf(world, `${DEV_LINE} [data-slot="team-notice-body"] strong`)).toBe("The report");
  expect(await textOf(world, '[data-timeline-row="TeamNotice"]')).not.toContain("[DEV]");
  saveScreenshot(world.env, "21-team-line-open", (await world.p.send("Page.captureScreenshot", { format: "png" })).result.data);

  // a second click closes it
  await mouseClick(world, trigger);
  await until("the line closed", async () => (await expanded()) === "false");
  expect(await body()).toBeNull();

  // the line is a button: Enter opens it and Space closes it
  await world.p.evaluate(`document.querySelector(${JSON.stringify(trigger)}).focus()`);
  const press = async (key: string, code: string, keyCode: number, text: string) => {
    await world.p.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, text });
    await world.p.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  };
  await press("Enter", "Enter", 13, "\r");
  await until("the line open with Enter", async () => (await expanded()) === "true");
  expect(await body()).toContain("ZZ-TAIL-ZZ");
  await press(" ", "Space", 32, " ");
  await until("the line closed with Space", async () => (await expanded()) === "false");

  // the automatic notice opens the same way, and shows what the agent said, not the Team's label
  await world.p.evaluate(`document.querySelector(${JSON.stringify(`${AUTOMATIC_LINE} button`)}).scrollIntoView({ block: "center" })`);
  await Bun.sleep(1000); // the list measures the rows it has scrolled to before the pointer lands on one
  await mouseClick(world, `${AUTOMATIC_LINE} button`);
  await until("the automatic line open", () => world.p.evaluate(`document.querySelector(${JSON.stringify(`${AUTOMATIC_LINE} [data-slot="team-notice-body"]`)}) !== null`));
  expect(await textOf(world, `${AUTOMATIC_LINE} [data-slot="team-notice-body"]`)).not.toContain("[AGENT");
}, 300_000);

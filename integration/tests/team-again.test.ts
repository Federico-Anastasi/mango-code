// The Team turned off in one conversation and on again in a new one: the new conversation is the manager's, with the
// manager's model under the box, and stays so. Real window and real agent, fake local engine and fake cloud (see team-world.ts).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { saveScreenshot } from "./environment";
import { completions, mouseClick, startWorld, stopWorld, textOf, until, write, type World } from "./team-world";

const START = "ZZ-START-ZZ";
const AGAIN = "ZZ-AGAIN-ZZ";
const SWITCH = '[data-action="prompt-team"] [role="switch"]';
const MODEL = '[data-action="prompt-model"]';

let world: World;

const asked = (log: string, marker: string) => completions(log).some((r) => JSON.stringify(r.body.messages).includes(marker));
const href = () => world.p.evaluate("location.href") as Promise<string>;
const switchState = () => world.p.evaluate(`document.querySelector(${JSON.stringify(SWITCH)})?.getAttribute("aria-checked")`);

async function newConversationWithTeam(text: string) {
  await until("the button of a new conversation", () => world.p.evaluate(`!!document.querySelector('[aria-label="Nuova conversazione"]')`));
  const before = await href();
  await mouseClick(world, '[aria-label="Nuova conversazione"]');
  await until("the new conversation", async () => {
    const now = await href();
    return now !== before && now.includes("/new-session");
  });
  await until("the composer", () => world.p.evaluate(`!!document.querySelector('[contenteditable="true"]')`));
  await until("the Team switch", () => world.p.evaluate(`!!document.querySelector(${JSON.stringify(SWITCH)})`));
  await mouseClick(world, SWITCH);
  await until("the switch on", async () => (await switchState()) === "true");
  await until("the manager's model under the box", async () => (await textOf(world, MODEL)).includes("Cloud fake"));
  await Bun.sleep(1000);
  expect(await switchState()).toBe("true");
  expect(await textOf(world, MODEL)).toContain("Cloud fake");
  await write(world, text);
}

beforeAll(async () => {
  world = await startWorld([{ summary: "A title" }, { text: "The local model answers." }], [{ summary: "A title" }, { text: "The manager answers." }], { agents: 1 });
}, 300_000);

afterAll(() => stopWorld(world));

test("the Team turned off in a conversation and on in a new one: the new conversation is the manager's", async () => {
  await newConversationWithTeam(START);
  await until("the manager's answer", async () => (await textOf(world, '[data-component="text-part"]')).includes("The manager answers."));
  await mouseClick(world, SWITCH);
  await until("the switch off", async () => (await switchState()) === "false");

  await newConversationWithTeam(AGAIN);
  saveScreenshot(world.env, "team-again", (await world.p.send("Page.captureScreenshot", { format: "png" })).result.data);

  await until("the manager asked", () => asked(world.cloudLog, AGAIN), 60_000);
  await until("the manager's answer", async () => (await textOf(world, '[data-component="text-part"]')).includes("The manager answers."));
  expect(await textOf(world, '[data-component="text-part"]')).not.toContain("The local model answers.");
  expect(asked(world.env.engineLog, AGAIN)).toBe(false);
}, 240_000);

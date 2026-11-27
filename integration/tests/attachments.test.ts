// The user attaches files to a message, in the app's real window, with the real mouse: «Immagini e file» in the box's «+» menu
// opens the file chooser (the test answers it the way the dialog would, with the paths), or a file is dropped on the box; a picture,
// a text file and a PDF each show as a chip, a chip can be removed before sending, a file the app cannot take says so and adds
// no chip, the same file twice is one chip. What leaves with the message reaches the engine: for a model that sees pictures the
// picture itself, for one that does not a sentence with the place of the saved copy in the project (and the box says so as soon as
// the picture is attached); the text file's words and the PDF's text are in the request; what was removed is nowhere in it.
// The conversation shows the chips again after the page is loaded anew. Fake engine, window driven over CDP.
// `off-screen bun test --cwd integration tests/attachments.test.ts`.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowPage, type Page } from "./cdp";
import { start, type Environment } from "./environment";

setDefaultTimeout(120_000);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const NOTE = "Remember the milk and the eggs.\n";

/** A PDF with one page and this content stream, offsets and all. */
function pdf(content: string) {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const at = objects.map((o, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mango-attach-"));
const things = path.join(root, "things");
fs.mkdirSync(things);
const file = (name: string) => path.join(things, name);
fs.writeFileSync(file("dot.png"), PNG);
fs.writeFileSync(file("note.txt"), NOTE);
fs.writeFileSync(file("figures.pdf"), pdf("BT /F1 18 Tf 20 100 Td (Quarterly figures are up nine percent) Tj ET"));
// a binary with zeros in it: neither a picture, nor a document, nor text
fs.writeFileSync(file("blob.bin"), Buffer.from(Array.from({ length: 600 }, (_, i) => (i % 7 === 0 ? 0 : (i * 37) % 256))));
// a PDF of a scan (a page and no text) and one that is not a PDF inside: the user attaches both as they are
fs.writeFileSync(file("scan.pdf"), pdf("0 0 10 10 re f"));
fs.writeFileSync(file("broken.pdf"), "%PDF-1.4\nthis is not a document at all\n");

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

for (const sees of [true, false]) {
  describe(sees ? "a model that sees pictures" : "a model that reads only text", () => {
    let env: Environment;
    let p: Page;
    let site: string;

    async function waitUntil(condition: () => Promise<boolean> | boolean, what: string, ms = 30_000) {
      const t0 = Date.now();
      while (!(await Promise.resolve(condition()).catch(() => false))) {
        if (Date.now() - t0 > ms) {
          const seen = await p.evaluate("document.body.innerText.slice(-600)").catch(() => "");
          throw new Error(["waited too long for: " + what, "--- the page ---", seen, "--- console ---", ...p.console.slice(-4)].join("\n"));
        }
        await Bun.sleep(150);
      }
    }
    const exists = (selector: string) => p.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`) as Promise<boolean>;
    const body = () => p.evaluate("document.body.innerText") as Promise<string>;
    const centre = (find: string) =>
      p.evaluate(`(() => { const el = ${find}; if (!el) return null; el.scrollIntoView({ block: "center" }); const q = el.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; })()`) as Promise<{ x: number; y: number } | null>;
    async function click(find: string, what: string) {
      const at = await centre(find);
      if (!at) throw new Error(`not on the page: ${what}`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await p.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    }
    const q = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
    /** A picture of the window in the folder `MANGO_TEST_SCREENSHOTS` names, if it is set. */
    async function shot(name: string) {
      const folder = process.env.MANGO_TEST_SCREENSHOTS;
      if (!folder) return;
      fs.mkdirSync(folder, { recursive: true });
      const taken = await p.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(folder, `${name}.png`), Buffer.from(taken.result.data, "base64"));
    }

    /** What the box shows as attached: the file names of its chips, in order. */
    const chips = () =>
      p.evaluate(`[...document.querySelectorAll('[data-component="prompt-input-v2-attachments"] [data-slot="prompt-attachments-scroll"] > div')].map((c) => c.querySelector("img")?.alt ?? c.querySelector('[data-slot="attachment-card-v2-title"]')?.textContent ?? "?")`) as Promise<string[]>;

    /** «+» then «Immagini e file», as a person does; the file chooser the page opens is answered with `paths`, as the dialog would. */
    let chooser: { backendNodeId: number } | undefined;
    let listening = false;
    async function attach(...paths: string[]) {
      if (!listening) {
        p.on("Page.fileChooserOpened", (e) => (chooser = e));
        listening = true;
      }
      await p.send("Page.enable");
      // a page loaded again forgets that the chooser is answered here
      await p.send("Page.setInterceptFileChooserDialog", { enabled: true });
      chooser = undefined;
      await click(q('[data-action="prompt-attach"]'), "the + button");
      await waitUntil(() => exists('[role="menuitem"]'), "the menu of the + button");
      await click(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes("Immagini e file"))`, "Immagini e file");
      await waitUntil(() => chooser !== undefined, "the file chooser");
      await p.send("DOM.setFileInputFiles", { files: paths, backendNodeId: chooser!.backendNodeId });
      chooser = undefined;
    }

    /** A drop of real files on the box, as the pointer does it. */
    async function drop(...paths: string[]) {
      const at = (await centre(q('[data-component="prompt-input-v2"]')))!;
      const data = { items: [], files: paths, dragOperationsMask: 1 };
      await p.send("Input.dispatchDragEvent", { type: "dragEnter", x: at.x, y: at.y, data });
      await p.send("Input.dispatchDragEvent", { type: "dragOver", x: at.x, y: at.y, data });
      await p.send("Input.dispatchDragEvent", { type: "drop", x: at.x, y: at.y, data });
    }

    async function write(words: string) {
      await click(q('[data-component="prompt-input"]'), "the box");
      await p.send("Input.insertText", { text: words });
    }
    const send = () => click(q('[data-action="prompt-submit"]'), "the send button");
    const sendOn = () => p.evaluate(`${q('[data-action="prompt-submit"]')}?.disabled === false`) as Promise<boolean>;

    const requests = () =>
      (fs.existsSync(env.engineLog) ? fs.readFileSync(env.engineLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((r: { route: string }) => r.route.startsWith("/v1/chat/completions"));
    /** The request in which the user's message with `words` reached the engine. */
    const requestWith = async (words: string) => {
      await waitUntil(() => requests().some((r: { body: unknown }) => JSON.stringify(r.body).includes(words)), `the message «${words}» at the engine`);
      return requests().find((r: { body: unknown }) => JSON.stringify(r.body).includes(words)) as { body: { messages: { role: string; content: unknown }[] } };
    };
    const lastUser = (r: { body: { messages: { role: string; content: unknown }[] } }) => r.body.messages.filter((m) => m.role === "user").at(-1)!;

    /** «Nuova conversazione», and the box of the new one: the page has changed (a box of the old page would be replaced under the hands). */
    async function freshBox() {
      const before = (await p.evaluate("location.href")) as string;
      await click(q('[aria-label="Nuova conversazione"]'), "Nuova conversazione");
      await waitUntil(async () => (await p.evaluate("location.href")) !== before && ((await p.evaluate("location.pathname")) as string).endsWith("/new-session") && (await exists('[data-component="prompt-input"]')), "the box of a new conversation");
      await Bun.sleep(500);
    }
    async function newConversation() {
      await waitUntil(async () => (await body()).includes("my-site"), "the project open", 60_000);
      await freshBox();
    }
    /** The toast the page shows, by its words. */
    const toast = (words: string) => waitUntil(async () => (await body()).includes(words), `the notice «${words}»`, 10_000);

    beforeAll(async () => {
      site = path.join(root, `my-site-${sees ? "eyes" : "text"}`);
      fs.mkdirSync(site, { recursive: true });
      fs.writeFileSync(path.join(site, "a.txt"), "x");
      env = await start([{ text: "Got your files." }], { window: true, vision: sees, args: [`${site}\\.`] });
      p = await windowPage(env.cdp!, env.agent, 120_000);
      await newConversation();
    }, 240_000);

    afterAll(() => {
      p?.close();
      env?.close();
    });

    test("«Immagini e file» opens the chooser and the chosen files show as chips; a picture shows as itself, the others as cards with their kind", async () => {
      await attach(file("dot.png"), file("note.txt"), file("figures.pdf"));
      await waitUntil(async () => (await chips()).length === 3, "three chips");
      expect(await chips()).toEqual(["dot.png", "note.txt", "figures.pdf"]);
      await shot(sees ? "02-attachments-chips-model-sees-pictures" : "03-attachments-chips-model-text-only-note");
      const cards = await p.evaluate(`[...document.querySelectorAll('[data-component="attachment-card-v2"]')].map((c) => c.textContent)`);
      expect(cards).toEqual(["note.txtTXT", "figures.pdfPDF"]);
      // the picture is drawn: its blob loaded
      expect(await p.evaluate(`(() => { const i = document.querySelector('[data-slot="prompt-attachments"] img'); return i.complete && i.naturalWidth > 0; })()`)).toBe(true);
      // with only attachments in the box, there is something to send
      expect(await sendOn()).toBe(true);
      // the box tells a model that does not see pictures, as soon as one is attached, and says nothing to one that does
      const note = await p.evaluate(`${q('[data-slot="prompt-attachments-note"]')}?.textContent ?? ""`);
      if (sees) expect(note).toBe("");
      else expect(note).toBe("Questo modello non vede le immagini. Il file resta nel progetto e Mango Code può comunque usarlo.");
    });

    test("a chip is removed with its own button, before sending; the others stay", async () => {
      // the button shows when the pointer is on the chip
      const chip = `[...document.querySelectorAll('[data-slot="prompt-attachments-scroll"] > div')].find((c) => c.textContent.includes("figures.pdf"))`;
      const at = (await centre(chip))!;
      await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
      await click(`${chip}.querySelector('button[aria-label="Rimuovi allegato"]')`, "the remove button of the PDF");
      await waitUntil(async () => (await chips()).length === 2, "two chips");
      expect(await chips()).toEqual(["dot.png", "note.txt"]);
      if (!sees) expect(await exists('[data-slot="prompt-attachments-note"]')).toBe(true);
      // the last picture removed takes the note with it, and the same file comes back when attached again
      await attach(file("figures.pdf"));
      await waitUntil(async () => (await chips()).length === 3, "the PDF attached again");
      await click(`[...document.querySelectorAll('[data-slot="prompt-attachments-scroll"] > div')].find((c) => c.textContent.includes("figures.pdf")).querySelector('button[aria-label="Rimuovi allegato"]')`, "the remove button of the PDF");
      await waitUntil(async () => (await chips()).length === 2, "the PDF removed again");
    });

    test("what is sent reaches the engine, what was removed does not, and the box is empty afterwards", async () => {
      await write("Please look at the files DOTNOTE");
      await send();
      const request = await requestWith("DOTNOTE");
      const text = JSON.stringify(request.body);
      // the removed PDF is nowhere
      expect(text).not.toContain("figures.pdf");
      expect(text).not.toContain("Quarterly figures");
      // the text file's words are in the message
      expect(text).toContain("Remember the milk and the eggs.");
      const parts = lastUser(request).content as { type: string; text?: string; image_url?: { url: string } }[];
      const images = parts.filter((part) => part.type === "image_url");
      if (sees) {
        expect(images.map((i) => i.image_url!.url)).toEqual([`data:image/png;base64,${PNG.toString("base64")}`]);
      } else {
        expect(images).toEqual([]);
        // the model is told where the copy of the picture is
        const told = parts.map((part) => part.text ?? "").find((t) => t.includes("«dot.png»") && t.includes("saved in"));
        expect(told, "a sentence that names dot.png and where it was saved").toBeTruthy();
        expect(told).toContain(path.join(site, "Attachments", "dot.png"));
      }
      // the copy in the project is the file, byte for byte
      await waitUntil(() => fs.existsSync(path.join(site, "Attachments", "dot.png")), "the copy of the picture in the project");
      expect(fs.readFileSync(path.join(site, "Attachments", "dot.png")).equals(PNG)).toBe(true);
      // the box is clean and the conversation shows what was sent
      expect(await chips()).toEqual([]);
      await waitUntil(async () => (await body()).includes("Got your files."), "the answer");
      expect(await body()).toContain("note.txt");
    });

    test("the conversation, loaded again, shows the files that were sent with the message", async () => {
      const url = (await p.evaluate("location.href")) as string;
      await p.send("Page.navigate", { url });
      await waitUntil(async () => (await body()).includes("Please look at the files DOTNOTE"), "the conversation");
      await waitUntil(async () => (await body()).includes("note.txt"), "the text file among the files of the message");
      expect(await p.evaluate(`[...document.querySelectorAll('img')].some((i) => i.alt === "dot.png")`)).toBe(true);
      expect(await body()).not.toContain("figures.pdf");
    });

    test("a PDF is read: its text reaches the engine", async () => {
      await freshBox();
      await attach(file("figures.pdf"));
      await waitUntil(async () => (await chips()).length === 1, "the chip of the PDF");
      await write("Sum up the PDF PDFASK");
      await send();
      const request = await requestWith("PDFASK");
      const text = JSON.stringify(lastUser(request).content);
      expect(text, "the text of the PDF, in the message that carries it").toContain("Quarterly figures are up nine");
      expect(text).not.toContain("could not read");
    });

    test("a PDF with no text (a scan) and a PDF that cannot be opened each reach the model with a sentence that says what is wrong, not the reader's internals", async () => {
      await freshBox();
      await attach(file("scan.pdf"), file("broken.pdf"));
      await waitUntil(async () => (await chips()).length === 2, "two chips");
      await write("Read both PDFASK2");
      await send();
      const request = await requestWith("PDFASK2");
      const told = (lastUser(request).content as { text?: string }[]).map((part) => part.text ?? "").filter((t) => t.includes("scan.pdf") || t.includes("broken.pdf"));
      await shot("04-scanned-pdf-sent-conversation");
      expect(told.join("\n")).toContain("no selectable text");
      for (const sentence of told) expect(sentence, "no internal error text of the reader").not.toContain("Effect.tryPromise");
      expect(told.find((t) => t.includes("«broken.pdf» (saved in")), "a sentence for the PDF that cannot be opened").toBeTruthy();
    });

    test("files dropped on the box become chips, a picture and a text file alike", async () => {
      await freshBox();
      await drop(file("dot.png"), file("note.txt"));
      await waitUntil(async () => (await chips()).length === 2, "two chips from the drop");
      expect(await chips()).toEqual(["dot.png", "note.txt"]);
      await write("A dropped message DROPASK");
      await send();
      const request = await requestWith("DROPASK");
      expect(JSON.stringify(request.body)).toContain("Remember the milk and the eggs.");
      expect(await chips()).toEqual([]);
    });

    test("a file that is neither a picture, a document nor text says so and adds no chip", async () => {
      await freshBox();
      await attach(file("blob.bin"));
      await toast("Allegato non supportato");
      expect(await body()).toContain("Qui è possibile allegare solo immagini, PDF, Word, Excel, PowerPoint o file di testo.");
      expect(await chips()).toEqual([]);
      expect(await sendOn()).toBe(false);
    });

    test("the same file attached twice is one chip, and the notice says it was there", async () => {
      await attach(file("note.txt"));
      await waitUntil(async () => (await chips()).length === 1, "the chip");
      await attach(file("note.txt"));
      await toast("Questo file è già stato caricato");
      expect(await chips()).toEqual(["note.txt"]);
    });
  });
}

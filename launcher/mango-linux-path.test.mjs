// The one rule for the paths a model writes for another computer, the same for every tool that takes a path.
// `node --test launcher/mango-linux-path.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromLinux } from "./mango-linux-path.mjs";

const PROJECT = "C:\\Users\\someone\\Projects\\shop";
const has = (name) => name === "data";

test("a drive written as a folder is that drive, for Git Bash, WSL and Cygwin", () => {
  for (const written of ["/c/Users/someone/notes.txt", "/mnt/c/Users/someone/notes.txt", "/cygdrive/c/Users/someone/notes.txt"])
    assert.deepEqual(fromLinux(PROJECT, written, has), { path: "C:\\Users\\someone\\notes.txt", moved: false }, written);
  assert.deepEqual(fromLinux(PROJECT, "/d", has), { path: "D:\\", moved: false });
});

test("a path of this computer without its drive stays where it is", () => {
  assert.deepEqual(fromLinux(PROJECT, "/Users/someone/Projects/shop/a.txt", has), { path: "C:\\Users\\someone\\Projects\\shop\\a.txt", moved: false });
  assert.deepEqual(fromLinux(PROJECT, "/Windows/notepad.exe", has), { path: "C:\\Windows\\notepad.exe", moved: false });
});

test("a path written for Linux is taken from the project folder", () => {
  const cases = [
    ["/home/user/shop/site/index.html", "site\\index.html"],
    ["/home/user/site/index.html", "site\\index.html"],
    ["/home/report.pdf", "report.pdf"],
    ["/tmp/out.log", "out.log"],
    ["/workspace/app.js", "app.js"],
    ["/data/orders.csv", "data\\orders.csv"],
    ["/output/orders.csv", "orders.csv"],
    ["/notes/a.txt", "notes\\a.txt"],
  ];
  for (const [written, inside] of cases)
    assert.deepEqual(fromLinux(PROJECT, written, has), { path: `${PROJECT}\\${inside}`, moved: true }, written);
});

test("a path that does not start with one slash is not one of these", () => {
  for (const written of ["site/index.html", "C:\\temp\\a.txt", "\\\\server\\share\\a.txt", "/"]) assert.equal(fromLinux(PROJECT, written, has), undefined, written);
});

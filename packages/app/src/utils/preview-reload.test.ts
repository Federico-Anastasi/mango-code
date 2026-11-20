import { describe, expect, test } from "bun:test"
import { pageChangedBy } from "./preview-reload"

describe("the preview reloads when the model changes a file of the page shown", () => {
  test("a page opened from disk: a file in its folder or below it, however the path is written", () => {
    const page = "file:///C:/Users/x/Pizzeria/index.html"
    expect(pageChangedBy(page, "C:\\Users\\x\\Pizzeria\\index.html")).toBe(true)
    expect(pageChangedBy(page, "c:/users/x/pizzeria/css/style.css")).toBe(true)
    expect(pageChangedBy("file:///C:/Users/x/La%20Pizzeria/index.html", "C:\\Users\\x\\La Pizzeria\\menu.js")).toBe(true)
  })

  test("a page opened from disk: a file elsewhere does not reload it", () => {
    const page = "file:///C:/Users/x/Pizzeria/index.html"
    expect(pageChangedBy(page, "C:\\Users\\x\\notes.txt")).toBe(false)
    expect(pageChangedBy(page, "C:\\Users\\x\\Pizzeria-old\\index.html")).toBe(false)
  })

  test("a page of a server on this PC: a file of the web reloads it, another file does not", () => {
    expect(pageChangedBy("http://localhost:5173/", "C:\\p\\src\\App.tsx")).toBe(true)
    expect(pageChangedBy("http://127.0.0.1:8000/menu.html", "C:\\p\\static\\style.css")).toBe(true)
    expect(pageChangedBy("http://localhost:8000/", "C:\\p\\server.py")).toBe(false)
    expect(pageChangedBy("http://localhost:8000/", "C:\\p\\README.md")).toBe(false)
  })

  test("a page on the internet, or no page, is never reloaded", () => {
    expect(pageChangedBy("https://example.com/", "C:\\p\\index.html")).toBe(false)
    expect(pageChangedBy("", "C:\\p\\index.html")).toBe(false)
    expect(pageChangedBy("about:blank", "C:\\p\\index.html")).toBe(false)
  })
})

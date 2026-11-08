---
name: word
description: "Creates, reads and edits Word documents (.docx): letters, reports, contracts, minutes, with headings, lists, tables and images. Use it when the user talks about Word, a .docx file, or asks to write, correct or complete a document."
---

# Word (.docx)

You work with four tools, without writing code:
`documents_create` (new file), `documents_read`, `documents_edit` (existing file), `documents_convert`.
After every call the file appears in the chat with buttons to open it: tell the user in one line what you did.

## Create

`documents_create` with `type: "docx"`, `file` (e.g. `letter.docx`), `content` in Markdown, and if needed
`style` (`blue` default, `green`, `orange`, `graphite`) and `header` (small text at the top of every page).
The page number at the bottom is already there.

```
# Quarterly report
## Results
Text with **bold**, *italic* and a [link](https://example.com).
- point
  - sub-point
1. first
2. second

| Item | Amount |
|------|-------:|
| Rent | 800 |

![Logo](logo.png)
[[page]]
## Conclusions
```

- A single `#` for the document title; `##` and `###` for the sections.
- `[[page]]` alone on a line starts a new page. `---` is a separator line.
- Images are PNG, JPEG or GIF files already in the project (name or path): do not invent them, no web addresses.
- Accented letters and non-English characters are written normally.
- A letter: write sender, date, recipient, subject and greetings as normal paragraphs, one per empty line.

## Read

`documents_read` with `file`: returns the text with `#` for headings, lists, tables, header and footer.
A long document is read in parts: the answer says `continue with part=2`.

## Edit an existing file

First `documents_read`, then ONE `documents_edit` call with the operations in order. The rest of the document
(styles, images, headers, layout) stays as it is.

```
file: "contract.docx"
operations: [
  {"action": "replace", "find": "John Smith", "with": "Luke Brown"},
  {"action": "add", "markdown": "## Penalties\nIn case of delay...", "after": "Contract term"},
  {"action": "add_table_row", "table": 1, "cells": ["Gas", "45"], "after": "Power"},
  {"action": "delete", "text": "Draft, not final"}
]
```

- `replace`: `find` must be copied exactly as `documents_read` shows it (capitals, accents); it lies within a single
  paragraph. It also changes headers and footers. The new text takes the format of where the old one starts.
- `add`: the Markdown is the same as for creation. Where: at the end (default), `"where": "start"`, `"after"` or `"before"`
  with a piece of the text of a paragraph, or `"end_of_section"` with the heading of a section.
- `delete`: removes the first paragraph that contains the text. `delete_section`: removes a heading and everything below it.
- `add_table_row`: copies the formatting of the last row (or of the one indicated by `after`); as many texts as there are
  columns are needed.
- To keep the original intact use `save_as` with a new name: do it when the change is big or the file is the user's.
- If an operation fails nothing is saved: read the error, fix that one and send everything again.

## Convert

`documents_convert` with `format: "pdf"` makes a **simplified** PDF: headings, lists, tables, images and bold/italic,
but not the original fonts, colors and margins. If the user wants the identical PDF, they must open the file in Word and use Save as PDF.

## What cannot be done (say so, do not promise)

- Tracked changes, comments, automatic table of contents, footnotes, Word fields and forms.
- Charts inside Word: put the numbers in a table, or create the chart in Excel or PowerPoint.
- Seeing how the document looks; editing an old `.doc` (it must first be saved as `.docx` from Word).
- Changing the look of existing text (bold, color, font): only the text is changed.

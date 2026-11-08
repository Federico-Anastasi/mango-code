---
name: pdf
description: Creates PDFs (with correct accents), reads the text and the form fields of a PDF, merges, splits, rotates, reorders pages, adds watermark and page numbers, fills PDF forms; converts Word documents and Excel sheets to a simplified PDF. Use it for any .pdf file or when the user asks for a PDF.
---

# PDF

Tools, without writing code: `documents_create` (type pdf), `documents_read`,
`documents_edit`, `documents_convert`. The file appears in the chat with buttons to open it.

## Create

`documents_create` with `type: "pdf"`, `file` (e.g. `offer.pdf`), `content` in Markdown, `style` and `header` optional.
Same Markdown as Word documents: `#` headings, `**bold**`, `*italic*`, lists, tables, `![caption](logo.png)`
(PNG or JPEG already in the project), `[[page]]` to start a new page. Accents and € are fine. The page number
at the bottom is already there. Charts in PDF are not possible: put the data in a table.

## Read

`documents_read`: text page by page, the columns of a table separated by two spaces, and the list of fields if it is a
form. At most 20 pages at a time: the answer says `continue with part="21-40"`. To look for something in a long
PDF, read in blocks and note the page numbers; a quotation always carries the page.
**If a page has no text it is a scan**: there is no text recognition (OCR), you cannot read it. Tell
the user and ask for a version with text, never invent the content.

## Edit an existing file

First `documents_read` (number of pages, field names). Then ONE `documents_edit` call:

```
file: "contract.pdf"
operations: [
  {"action": "merge", "other_files": ["C:\\...\\attachment.pdf"]},
  {"action": "delete_pages", "pages": "2"},
  {"action": "rotate", "degrees": 90, "pages": "3"},
  {"action": "watermark", "text": "DRAFT"},
  {"action": "number_pages"}
]
save_as: "contract-final.pdf"
```

- `pages`: numbers from 1, with ranges: `"1-3,5"`; if missing, all pages.
- `merge`: appends the pages of `other_files` (full paths or names in the project folder).
- `extract_pages`: keeps only those pages (with `save_as` you get a new PDF with an extract: the original stays).
- `delete_pages`; `reorder` with `"order": "3,1,2"` (all the pages, once each); `rotate` by 90, 180 or 270 degrees.
- `split` with `"every": 1` (pages per file) creates `name_part1.pdf`, `name_part2.pdf`...; it must be requested alone.
- `watermark`: gray diagonal text (Latin letters, numbers, accents). `number_pages`: «1 / 10» at the bottom (do not do it if the
  PDF already has numbers).
- `fill_form` with `"fields": {"Name": "John Smith", "Accept": "true", "City": "Rome"}`: the exact names come from
  `documents_read`. Checkboxes: `true` or `false`; lists: one of the listed items. The form stays editable.
- Without `save_as` the file is replaced: for the user's files always use `save_as`.

## Convert

`documents_convert` with `format: "pdf"` from `.docx` or `.xlsx`: **simplified** PDF (text, headings, lists, tables and images
with the Mango style; not the original fonts, colors and layout). For a PDF identical to the original the user uses Save as PDF
in Word or Excel. From PowerPoint to PDF it is not possible.

## What cannot be done (say so, do not promise)

- Changing the text already written in a PDF (the document is redone from the source, with `documents_create`).
- Protecting with a password or removing the password; signing digitally.
- Reading scans and images (no OCR); extracting the images; rebuilding the cells of a table.
- Opening the PDF to see how it looks.

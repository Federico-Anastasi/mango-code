---
name: powerpoint
description: "Creates, reads and edits PowerPoint presentations (.pptx): slides with title, lists, tables, images, charts and speaker notes; adds, deletes, moves slides and replaces texts in an existing file. Use it when the talk is about slides, presentations, PowerPoint or a .pptx file."
---

# PowerPoint (.pptx)

Tools, without writing code: `documents_create` (type pptx), `documents_read`,
`documents_edit`. The file appears in the chat with buttons to open it.

## Create

`documents_create` with `type: "pptx"`, `file` (e.g. `plan.pptx`), `content` in Markdown, `style` optional
(`blue` default, `green`, `orange`, `graphite`). Each `# Title` is a slide.

```
# Plan 2027
Presentation for the board

# Goals
- Grow by **15%**
- Open two offices
> Say that the estimates are prudent.

# Revenue
| Quarter | Revenue | Costs |
|---|---:|---:|
| Q1 | 1200 | 800 |
| Q2 | 1500 | 900 |

[[chart: bar | Revenue and costs]]

# Our team
Accompanying text.
![Photo](team.png)
```

- The first slide with only a title and a sentence is the cover (colored background).
- **A slide says one thing only**: a title that states something, at most 6 points with short lines, or a table,
  a chart or an image. If more is needed, make two slides. No walls of text.
- `> text` is the speaker note (not visible in projection).
- `---` on a line (or `[[page]]`) opens a slide without a title.
- Chart: `[[chart: bar]]` (also `line`, `pie`, `horizontal`) right after a table: first column labels,
  the others only numbers with the decimal point. The table becomes the chart (it is not also shown as a table).
- Images: PNG, JPEG or GIF files already in the project; with some text they go beside it, alone they fill the slide.
- If the data is a lot, do not put it in slides: summarize and propose a separate Excel sheet.

## Read

`documents_read`: for each slide the title, the text (with `-` for lists), the tables, `[image]`, `[chart]` and the
speaker notes. Many slides: `part: "5-9"`.

## Edit an existing file

First `documents_read` (the slide numbers are needed, from 1). Then ONE `documents_edit` call:

```
file: "plan.pptx"
operations: [
  {"action": "replace", "find": "2026", "with": "2027"},
  {"action": "add_slide", "markdown": "# Risks\n- Market\n- Costs\n> Talk about the costs", "after": 3},
  {"action": "move_slide", "slide": 5, "to": 2},
  {"action": "delete_slide", "slide": 4}
]
```

- `replace`: changes the text in all the slides and in the notes, keeping the format. `find` within a single paragraph.
- `add_slide`: the Markdown is the same as for creation (also several slides, tables, charts, notes). `after` is the number
  of the slide to insert after (0 = at the start; without it: at the end). The new slides have our simple style (colored
  title, white background), not the graphic theme of the file.
- The other slides stay identical (layout, images, notes, sections). The operations are executed in order: after
  `add_slide` or `delete_slide` the numbers change, count accordingly (or make two calls).
- To keep the original use `save_as`.

## What cannot be done (say so, do not promise)

- Exporting to PDF or looking at how the slides appear (the PDF is made from PowerPoint with Save as).
- Animations, transitions, videos, SmartArt; changing the theme, the layout or the positions of the shapes of an existing slide.
- Changing the text of a table or chart already present: the slide is redone (`delete_slide` + `add_slide`).
- Editing an old `.ppt` (it must first be saved as `.pptx` from PowerPoint).

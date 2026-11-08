---
name: excel
description: "Creates, reads and edits Excel spreadsheets (.xlsx): tables with real formulas, totals, percentages, euro amounts, several sheets, charts; adds rows, columns and sheets to an existing file; converts to and from CSV. Use it when the talk is about Excel, an .xlsx, a CSV to open in Excel, accounts, budgets, lists to calculate."
---

# Excel (.xlsx)

Tools, without writing code: `documents_create` (type xlsx), `documents_read`,
`documents_edit`, `documents_convert`. The file appears in the chat with buttons to open it.

## Create

`documents_create` with `type: "xlsx"`, `file` (e.g. `budget.xlsx`), `content` in Markdown. Each `## Name` opens a sheet,
followed by a table: the first row is the header (row 1).

```
## Expenses
| Item | Month 1 | Month 2 | Total |
|------|--------:|--------:|------:|
| Rent | 800 | 800 | =B2+C2 |
| Power | €60.50 | 75 | =B3+C3 |
| Total | =SUM(B2:B3) | =SUM(C2:C3) | =SUM(D2:D3) |

| Item | Month 1 | Month 2 |
|------|--------:|--------:|
| Rent | 800 | 800 |
| Power | 60.5 | 75 |

[[chart: bar | Expenses per month]]
```

**Cells**
- Numbers: point for decimals, NEVER a thousands separator: `1250.5`, not `1.250,50`.
- Euro amounts: `€60.50` or `60.50 €` (they become numbers with the euro format). Percentages: `12%`. Dates: `2026-03-31`.
- Text that looks like a number (codes like `007`) stays text.
- **Formulas**: they start with `=`, English function names (`SUM`, `AVERAGE`, `IF`, `COUNT`, `MAX`, `VLOOKUP`), comma between
  the arguments. Rows are counted from 1 starting from the header: the first data row is 2.
  Totals and calculations ALWAYS as formulas, never numbers calculated in your head.
- Between two tables on the same sheet there is an empty row (it counts in the row numbers).

**Charts**: `[[chart: bar]]`, `line`, `pie` or `horizontal`, with a title after the bar. It goes right after a table in
which the first column is the labels and the others ONLY numbers (if the table also has text or date columns, make a
separate table with only the data to show). The chart updates if the numbers change.

**After creation** the answer may have `WARNING` lines: they are formulas that give an error (`#DIV/0!`, `#NAME?`) or
badly written numbers. Fix and recreate; do not say "done" with open warnings.

## Read

`documents_read`: shows each sheet as a table with the row numbers and the column letters, formulas as
`=B2+C2 → 1600` (formula and result). A long sheet is read in parts with `part` (`Expenses!A50:F120`).
Values are shown without the format (a euro amount appears as `60.5`).

## Edit an existing file

First `documents_read` (the row numbers are needed). Then ONE `documents_edit` call:

```
file: "budget.xlsx"
operations: [
  {"action": "set", "sheet": "Expenses", "cell": "B2", "values": 900},
  {"action": "add_rows", "sheet": "Expenses", "rows": [["Gas", 40, 55, "=B{r}+C{r}"]]},
  {"action": "add_column", "sheet": "Expenses", "header": "Average", "values": "=AVERAGE(B{r}:C{r})", "format": "number"},
  {"action": "format", "sheet": "Expenses", "range": "A1:D1", "bold": true, "fill": "yellow"},
  {"action": "add_sheet", "name": "Summary", "markdown": "| Item | Value |\n|---|---|\n| Tot | =SUM(Expenses!D2:D9) |"},
  {"action": "chart", "sheet": "Expenses", "range": "A1:C4", "type": "bar", "title": "Expenses", "position": "H2"}
]
```

- `sheet` can be omitted only if the file has a single sheet.
- `values`: a value, a list (one row), or a list of rows. Formulas start with `=`; `{r}` becomes the number of the row where
  the cell ends up (`=B{r}*C{r}`), `{r-1}` the row above.
- `set` writes from `cell` to the right and downwards. `clear` removes the values of a range.
- `add_rows` writes below the last used row and copies the format of the previous row. `add_column` puts the
  column on the right; with a single formula it fills all the data rows (or only `"rows": "2-9"`).
- `format`: `euro`, `percent`, `number`, `integer`, `date`, `text`. Colors: name (yellow, red, green, blue, orange,
  gray, black, white, lightblue, pink, purple) or code (FFFF00).
- `replace`: changes a text in the text cells (not in formulas).
- Formulas, formats, colors and charts already present stay. Formulas are recalculated; warnings are in the answer.
- To add rows ABOVE a total row: rewrite with `set` (new rows + the total again, with the updated formula) starting
  from the row of the old total.
- To keep the original intact use `save_as`.

## Convert

`documents_convert`: `xlsx` → `csv` (one file per sheet, or `sheet` for just one; `separator` `;` for Italian Excel,
`,` for other programs), `csv` → `xlsx` (recognizes separator, numbers and dates), `xlsx` → `pdf` (simplified: tables,
without colors and charts).

## What cannot be done (say so, do not promise)

- Inserting or deleting rows and columns IN THE MIDDLE of the data, deleting or renaming a sheet: the formulas that cite them
  would break. You add at the end or rewrite the table.
- Files with pivot tables, macros or slicers: they are not edited (they can be read); the user must use Excel.
- Very large files (over 15 MB): only a profile (columns, first rows), no edits.
- Conditional formatting, data validation, new pivot tables; old `.xls` files (they must first be saved as `.xlsx`).
- Recent Excel functions (`XLOOKUP`, `FILTER`, `LET`): they are written but the warning says they cannot be verified.

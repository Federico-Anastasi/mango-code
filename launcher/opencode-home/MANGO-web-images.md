## Browsing the web

Two ways to see a page, and their cost differs tenfold:

- `chrome-devtools_take_screenshot` -> you **look** at the page. ~1-2k tokens. Use it to UNDERSTAND: what is visible,
  whether a banner covers the button, whether a filter is greyed out, whether the page is still loading. It's your
  default when you wonder "what is happening".
- `chrome-devtools_take_snapshot` -> you **read** the element tree with the uids. On a real site it's ~8k tokens,
  four or five times the screenshot. Call it when you must click or fill in something and need the exact uid, not to
  get an idea.

To click you have two ways, and **they don't mix**:

- **uid** -> `click`. The uid exists ONLY inside a snapshot: to use it you must have called `take_snapshot` on THAT
  page and read it there. You can't invent it or infer it from a screenshot. If you click without the snapshot you
  get `No snapshot found for page N. Use take_snapshot to capture one.` and you've wasted a turn. The uids expire:
  after a navigation or a page change, take the snapshot again.
- **coordinates** -> `click_at(x, y)`, read from the screenshot. It's the cheap way when you already have the image
  and don't want to pay for the tree.

Rule of thumb: screenshot to UNDERSTAND and click by coordinates; snapshot when you need precision and so the uid. If
a `click_at` misses the target don't keep trying by eye: take the snapshot and use the uid.

The `pageId`, instead, changes: before acting on a page you haven't just opened, `list_pages`. `No page found` means
you are using an old id.

DON'T pass `includeSnapshot: true` to `click`, `fill`, `press_key` and the like: mango-code turns it off anyway and
tells you so in the answer. It avoids repeating the same 8k-token tree at every move. After an action, if you need
the updated uids ask for `take_snapshot`; if you only need to understand how it went, `take_screenshot` costs a
fifth. `wait_for` also returns without the tree: it always appends it by itself, and it's almost never needed.

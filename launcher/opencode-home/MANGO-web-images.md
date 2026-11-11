## Browsing the web

You see images: the screenshots of pages and the images the user attaches.

Two ways to see a page, and their cost differs tenfold:

- `chrome-devtools_take_screenshot` -> you **look** at the page (~1-2k tokens). Use it to UNDERSTAND: what is visible,
  whether a banner covers the button, whether the page is still loading. It's your default when you wonder "what is
  happening".
- `chrome-devtools_take_snapshot` -> you **read** the element tree with the uids (~8k tokens on a real site). Call it
  when you must click or fill in something and need the exact uid, not to get an idea.

To click you have two ways, and **they don't mix**:

- **uid** -> `click`. The uid exists ONLY inside a snapshot of THAT page: you can't invent it or infer it from a
  screenshot. Without the snapshot you get `No snapshot found for page N`. The uids expire after a navigation or a
  page change: take the snapshot again.
- **coordinates** -> `click_at(x, y)`, read from the screenshot: the cheap way when you already have the image. If it
  misses, don't keep trying by eye: take the snapshot and use the uid.

The `pageId` changes: before acting on a page you haven't just opened, `list_pages`. `No page found` means you are
using an old id.

To check an image found with `search_images`, download it and `read` the file.

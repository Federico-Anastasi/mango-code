---
name: no-deferred-work
description: "Use always while writing code: no TODOs, placeholders or 'I'll do it later'. Do the work now, or ask the user before leaving it out."
---

# No deferred work

Work left for later is work nobody does. If something is needed for the task, do it now.

## Not allowed in what you deliver

- `TODO`, `FIXME`, `HACK`, `XXX` comments.
- Placeholder bodies: a function that returns `true`, `{}` or a fixed value "for now".
- Error handling that only logs or rethrows with a "handle properly later" note.
- A feature that works only on the happy path when the other paths are part of the request.
- "Tests to add later".

## What to do instead

1. **Needed for this task?** Do it now: the validation, the error case, the test.
2. **Not needed, but you noticed it?** Don't write a comment about it. Tell the user in your answer, in one line, so
   they can decide.
3. **Needed, but too big or unclear?** Stop and ask the user before going on. Don't deliver half of it silently.

## Before you say "done"

- Search your changes for `TODO`, `FIXME`, `HACK`, `XXX`.
- Every error path does something deliberate (a clear message, a retry, a fallback the user knows about).
- The tests for the new behaviour exist and pass.
- Anything you left out was agreed with the user.

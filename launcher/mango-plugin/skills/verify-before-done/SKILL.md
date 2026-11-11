---
name: verify-before-done
description: "Use before saying that work is done, fixed or working, and while writing code: run the checks, read the result, leave no TODO or placeholders."
---

# Verify before you say done

Say "done", "fixed" or "works" only after you ran the check in this same turn and read its output. "It should work" is not a result.

1. Which command proves the claim?
2. Run it, in full, now.
3. Read all of the output: exit code, failures, warnings.
4. Say what happened, with the output or the numbers. If it doesn't confirm the claim, say the real state.

## What proves what
| Claim | Proof | Not proof |
|---|---|---|
| Tests pass | the test command's output: 0 failures | an earlier run, "it should" |
| It works | you ran it and show the output | the code looks right |
| Build is fine | the build command, exit code 0 | the linter passing |
| Bug is fixed | the original reproduction now passes | the code changed |
| Document is right | you read it back (`documents_read`) and counted what was asked | the tool said OK |
| Page works | you opened it in the browser and checked the console errors | the file was written |
| Everything asked is done | the request checked line by line | the tests pass |

If you delegated or ran something in the background, check the result yourself (files, diff) before reporting it.

## No deferred work
Not allowed in what you deliver: `TODO`, `FIXME`, `HACK` comments; placeholder bodies (a function that returns a fixed value "for now"); error handling that only logs; a feature that works only on the happy path when the other paths were asked for; "tests to add later".

- Needed for the task: do it now, the validation, the error case, the test.
- Noticed but not needed: don't write a comment, tell the user in one line.
- Needed but too big or unclear: stop and ask before going on. Don't deliver half of it in silence.

Before you say done: search your changes for `TODO`, `FIXME`, `HACK`, `XXX`; check that every error path does something deliberate (a clear message, a retry, a fallback the user knows about); check that the tests for the new behavior exist and pass.

---
name: research-after-failure
description: "Use after 2 failed attempts in a row at the same thing: stop guessing and look for the cause in the docs, the code and the web before trying again."
---

# Research after two failures

Two failed attempts in a row mean you are guessing. A third guess usually fails the same way. Stop and find out.

## What counts as a failure

The same goal attempted twice without success: a test still failing, the same error after a fix, a command that keeps
breaking, a change that doesn't have the effect you expected.

## What to do

1. **Write down what you tried** and what happened each time: the exact error, not a summary. Look for what the two
   attempts have in common.
2. **Read the project first.** The README and docs, the code around the failing spot, how the same thing is done
   elsewhere in the repository, the tests that cover it. `grep` for the error text and for the function names.
3. **Then the outside.** The documentation of the library or tool at the version the project uses, its issue tracker,
   the web. Search for the exact error message.
4. **Form one hypothesis that explains both failures**, and a way to check it before changing code: a log line, a
   small experiment, reading a value.
5. **Only then try again**, with a change that follows from what you found.

## When to stop and ask

If research doesn't give you a hypothesis that explains the failures, or the fix needs a decision that isn't yours
(changing an interface, removing a feature, a new dependency), tell the user what you tried, what you found and what
you would do next, and ask.

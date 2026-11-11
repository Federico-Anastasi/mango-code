---
name: debugging
description: "Use for any error, failing test or unexpected behavior, before changing code, and after 2 failed attempts at the same thing: find the cause first."
---

# Debugging: the cause first

A fix without a known cause is a guess. Don't change code until you can say what is wrong and why.

## 1. Find the cause
1. Read the whole error: message, stack trace, line numbers, exit code. It often says what is wrong.
2. Reproduce it with a command you can run again. If you can't, collect more data before guessing.
3. Check what changed: `git diff`, recent commits, a new dependency, a configuration.
4. If the data crosses several parts (script, tool, file), print what enters and leaves each part, once, to see where it breaks.
5. Follow a bad value backwards to where it comes from, and fix it there, not where it shows up.

## 2. Compare
Find similar code that works in the project and list every difference with the broken one, however small. If you copy a pattern, read it completely first.

## 3. One hypothesis at a time
Say "I think X is the cause because Y". Test it with the smallest change or a log line, one variable at a time. If it fails, form a new hypothesis: don't pile fixes on top. If you don't understand something, say so.

## 4. Fix
Have a failing test or a command that shows the bug (skill `test-first`), make one change that addresses the cause, then run it and the rest of the tests. No "while I'm here" changes.

## After 2 failed attempts: stop guessing
1. Write down what you tried and the exact error each time. What do the attempts have in common?
2. Read the project first: README and docs, the code around the failure, how the same thing is done elsewhere, the tests that cover it. `grep` the error text.
3. Then outside: the documentation of the library or tool at the version in use, its issue tracker, the web. Search the exact error message.
4. Form one hypothesis that explains both failures and check it before changing code.
5. Only then try again, with a change that follows from what you found.

If three fixes failed and each one revealed a problem somewhere else, the design may be wrong: tell the user what you found and ask before trying a fourth. The same if the fix needs a decision that isn't yours (changing an interface, removing a feature, a new dependency).

If the cause turns out to be external (network, timing, a service), say so and handle it on purpose: a retry, a timeout, a clear error message.

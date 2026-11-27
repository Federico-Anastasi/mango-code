desc: An error, a failing test, something that behaves wrong: the cause first

# Debugging: the cause first
A fix without a known cause is a guess. Don't change code until you can say what is wrong and why.

## 1. Find the cause
1. Read the whole error: message, line numbers, exit code. It often says what is wrong.
2. Reproduce it with a command you can run again in `terminal`.
3. Check what changed: `git diff`, the last commits, a new dependency, a setting.
4. Follow a wrong value backwards to where it comes from, and fix it there, not where it shows up.

## 2. Compare
`search` for code in the project that does the same thing and works. List every difference with the broken one, however small.

## 3. One hypothesis at a time
Say "I think X is the cause because Y". Test it with the smallest change, one thing at a time. If it fails, form a new hypothesis: don't pile fixes on top of each other.

## 4. Fix
Have a command or a test that shows the bug (skill `test-first`), make one change that removes the cause, then run it again together with the other tests. No "while I'm here" changes.

## After 2 failed attempts: stop guessing
1. Write down what you tried and the exact error each time. What do the attempts have in common?
2. Read the project: the README, the code around the failure, how the same thing is done elsewhere. `search` the text of the error.
3. Then outside: `web_search` the exact error message, and `web_open` the documentation of the library at the version in use.
4. Only then try again, with a change that follows from what you found.

If three fixes failed, or the fix needs a decision that is not yours (changing an interface, removing a feature, a new dependency): tell the user what you found and `ask`.

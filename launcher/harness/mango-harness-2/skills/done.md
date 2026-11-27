desc: The checks before you say that work is finished

# Check before you say done
Say "done", "fixed" or "it works" only after you ran the check now and read what it answered. "It should work" is not a result.

1. Which command proves it?
2. Run it now, in full.
3. Read all the output: exit code, failures, warnings.
4. Say what happened, with the output or the numbers. If it does not confirm, say the real state.

What proves what
- The tests pass: the output of the test command with 0 failures. Not an earlier run.
- It works: you ran it and show the output. Not "the code looks right".
- The bug is fixed: the command that showed the bug now passes. Not "the code changed".
- The page works: `page_view` shows what was asked and no error in the console. Not "the file was written".
- The document is right: you `read` it back and counted what was asked. Not "the command said made".
- Everything asked is done: the request checked line by line.

Nothing left for later
- No `TODO`, no `FIXME`, no function that returns a fixed value "for now".
- Needed for the job: do it now. Noticed but not needed: tell the user in one line. Needed but too big or unclear: stop and `ask`.

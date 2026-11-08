# Working hygiene

These are the rules we work by, and they matter as much as the optimizations: a badly measured optimization or a job left
dirty costs more than it gains. Where a method skill you may have (`verification-before-completion`, `test-driven-development`, `systematic-debugging`, `research-after-failure`, `no-deferred-work`) already covers a point, the text says so; the rule is written here anyway.

## Before measuring

- **Ask before using the GPUs.** An engine, a bench or a trial allocation on a GPU is launched only with the
  user's consent: these are the GPUs they work on. One heavy job per GPU at a time; with Mango Code running, the GPUs
  are taken on loan (`tools.md`).
- **Never stop a process by name.** Only by PID, and only the ones you started. The user's engine is not yours.
- **Idle machine:** nothing else heavy running; check free memory and GPU usage *before* (a
  bench refuses to start if a GPU already has hundreds of MiB in use).
- **Warm up and repeat:** the first request and idle GPUs (low clocks) distort the first point; the base is repeated to
  see how much it varies (`tools.md`). A difference inside the noise is not a difference.
- **Do not trust what you remember or what is written:** paths, versions, numbers in a document (the knowledge
  base too) are rechecked before use. Numbers declared by the hardware (bandwidth, free VRAM) are measured.
- **One thing at a time:** one change per trial; for each trial, the question written first ("if the KV goes to f16, does
  decode at 32k go up?"), the number afterwards.

## Doing trials well

- **The failing test first, then the code** (script, patch, kernel; skill `test-driven-development`, if you have it). The test
  that must give zero (or the identical text at temperature 0) exists before the patch.
- **A test is not weakened to make it pass:** if the threshold is wrong, you explain why and change it; you do not widen it
  until it passes.
- **Short trials and written numbers:** every trial ends in the log with command, setup, date and output. A number said
  aloud and not written does not exist.
- **After two failed attempts, stop and look for the cause** (the skills `systematic-debugging` and `research-after-failure`, if you have them): do not
  retry with another knob. Almost all the "does not start" cases on our bench were compute memory, found in the log.
- **Interface: a screenshot you actually looked at.** If the work touches a page or an app, the proof is a screenshot (DPI-aware) that
  you opened and looked at, not the absence of errors.
- **No fallback that hides an error:** an OOM stays an OOM, a failed download is a clear error. The silent fallback
  (`--fit` moving layers to the CPU, the pipeline that switches itself off) is what masked half of our problems.

## Independent verification

An important result (a profile, a patch, a recommendation "use this setup") is rechecked by **a separate agent,
without your context**. With your context it would rebuild your conclusion.

1. Give it: the PC (hardware, engine, files), the claim to verify ("setup X gives ≥ N tok/s at 32k, and the text is
   identical at temperature 0"), the command to redo the measurement (`mango-tune trial --base ...`), the trial log.
2. Do **not** give it: your hypotheses, why you think it works, the numbers you expect.
3. Its mandate is to **refute**: redo the measurements (at least the base and the final setup, repeated), look for the case in which
   the setup falls over (full context, long prompt, several conversations, restart), check the engine log, compare
   the text produced. It reports numbers and commands, not opinions.
4. If the numbers do not match within the noise, the work is not finished: find out why before writing the profile.
5. Sub-agents are fine for **independent** jobs (building a build while another reads documentation); two
   measurements on the same GPUs do not run in parallel.

Never say "done" without having verified: command output, numbers from the log, screenshots. (If you have it, the skill `verification-before-completion`.)

## At the end of every step

- **Recheck and clean the documentation** you touched: it says what is there and where it is, without history ("it used to do X"
  is no use to someone reading today). A rechecked number is in the document with its yardstick; one not reverified is not.
- **Remove the work that is no longer needed:** trial scripts, intermediate measurement files, trial builds, branches, model
  copies, superseded documents. If it is needed as proof of the result, only the log stays.
- **No dead code, no placeholders, no code for cases we do not have** (the skill `no-deferred-work`, if you have it): a
  patch or script written "for later" is removed.
- **Small, clear commits**, in English, with the paths added one by one; the message says what changes and why, with
  the number that justifies it. Never references to AI tools. No push unless asked.

## Comments

Short, direct, they say **why** and not what: the code says what. No change chronicle ("added for...", "it used to be..."):
history lives in the commits. A comment that ages with the next change is wrong today.

## The "bananas"

A banana is a conscious mistake left for whoever comes after: written under an assumption that seemed reasonable and that makes the
next reader slip. Before delivering work that outlives the session (profile, report, patch, document), reread it
looking for them. Four categories:

- **Communication:** the information is right but for another reader: jargon where an instruction is needed, implementation details where
  the behavior matters. The optimization report will be read by the user, not by an engine engineer.
- **Code and architecture:** near-identical duplicates, abstractions for a single use, dead code, switches for hypothetical scenarios, half-finished
  drafts in the live path, compatibility for cases that no longer exist.
- **Logic:** what compiles and silently does the wrong thing: fallbacks that mask an error, conditions always true under unexpected inputs,
  a "no data" propagated as a valid value, a default that replaces a missing required value.
- **Process and context:** "done" declared without functional verification, recommendations from memory not rechecked, paths cited from old
  memories, an attempt repeated without diagnosis, decisions that rest on changed assumptions.

Check questions: does the reader know all the terms? If I remove it, does the behavior change or only the "completeness"? Does this condition ever fail
with realistic inputs? If this fails, does the error surface or get swallowed? Am I building for "it might be needed" or "it is needed now"? Am I assuming
something that holds today but not in three months? Is it done because I built it or because I verified it works? Does it already exist, or am I writing a clone?

A clear banana is removed and mentioned in the report ("cleaned up N items of type X"). If a competent person could defend keeping it, it is
flagged and you ask. Do not overdo it: necessary complexity, abstractions used three times, defenses at boundaries (user input, external APIs) are not
bananas. Discriminator: removing it loses behavior (not a banana) or only clarity (it is one).

## New components

For every new component (a script, a measurement tool) evaluate **Rust**: robustness, speed, a single executable to distribute. If you choose
something else, the reason is concrete (a necessary ecosystem, existing code to extend, the bottleneck is elsewhere), not convenience. `mango-tune`
is in Rust for this reason; for an ad hoc extension of a single measurement, a small script is fine if it does not enter the distribution.

## Answers and reports

Dense and short: the user reads 3-10 lines, not twenty. An optimization report opens with the answer (what pays off, by how much, with which
setup), then the table of measurements, then what was not tried and why. No preambles, no summary of what you are about to say.

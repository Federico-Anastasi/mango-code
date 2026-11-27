## first
Create a new anchored summary from the conversation history above so another coding agent can continue the work.

## update
The summary message above, the one that says the conversation continues from a summary, is the <prior-summary>. The messages after it are the <conversation>.

The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.

## template
Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.

## rule
One more rule: the messages of the user, the skills you read and your task list stay in the conversation exactly as they are, so do not copy them into the summary. Report the work done and what you saw: the facts, figures, names and results the work still needs. The files read and the files changed are listed after your summary: do not list them yourself.

## continued
This conversation continues from a summary of its earlier part. What the user said, the skills you read and your task list are above; what you did and saw before the last messages is told below.

## files-read
Files read in the whole conversation:

## files-changed
Files written or edited in the whole conversation:

## missing
Messages of the user left out here, between the first and the ones that follow: {{missing}}.

## unwritten
This summary was put together from the work itself, not written by you: the earlier summary, if there was one, then the latest tool calls since, each with the start of what it gave back. Read again what you still need.

## cut
[Cut here to fit the context: this result is {{whole}} tokens and only {{kept}} fit now. Read the rest in parts, from where this stops.]

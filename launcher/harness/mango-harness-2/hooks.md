## after-failed-call
That did not work. The answer above says what was wrong: change the command. Do not send it again as it is.

## same-call-again
This is the same command as before, and it failed the same way. It was not run. Do something different: read the error again, look at the folder with `read`, or `ask` the user.

## outside-project
`{{path}}` is outside the project, so nothing was done. Paths start from the project folder, which holds:
{{listing}}

## path-taken-from-project
`{{path}}` is not a path of this computer: `{{used}}` in the project folder was used. Paths start from the project folder.

## after-page-written
You wrote a page. `page_view` it before you say it is done.

## every-calls
You have made {{calls}} calls. If the request is done, answer the user now. If you are stuck, say in one line what blocks you.

## plan-open-every-calls
Your plan still has these steps open:
{{open_steps}}
Do the next one, and mark it with `plan` when you have checked it. If the plan is wrong, write it again.

## cd-in-terminal
Not run: every command starts in the project folder. To run one somewhere else give `folder`, like `src`. The project folder holds:
{{listing}}

## file-named-otherwise
You wrote `{{path}}`, but the request names {{named}}, which is not there yet. If that is the file the user asked for, give it the name the user gave.

## answer-without-opening
Not shown to the user yet. You answered from the lines of the search results, but you opened no page: those lines are a few words of each page, and sites that compare or discuss often repeat an old fact. Open with `web_open` the page of the source itself, the one the request points to, then answer with what that page says.

## would-lose
Not done: this would lose what the user had in the project, and it cannot be had back:
{{what}}
The harness asked the user whether to go on. The user answered: «{{answer}}»
Do what the user said. If they said yes, send the command again.

## web-in-terminal
Not run: {{url}} is a page, and a program of the terminal gets only its empty shell, because what the page shows is written by its scripts. Open it with `page_view` (a page of the web that a search found: `web_open`), then click and type in it with `page_act`.

## web-before-own-tools
Not searched yet. The user has tools of their own for their work, in your list of commands:
{{tools}}
A fact of the user's own work (a price of theirs, a stock, a booking, the state of a case) is in one of these, not on the web: call the one that fits. If none fits, search again.

## page-not-found
This site has no page at {{url}}: its addresses are not guessed. The page you were on, {{back}}, is open again, and these are its links and buttons:
{{page}}
Click with `page_act` the one that leads where you want to go.

## rules-in-messages
<mango-rules>
Rules that stay on while you work. They are not the user's request: don't act on them, follow them.
1. Paths start from the project folder.
2. Each job has its command: `search`, `read`, `edit`, `write`; `terminal` only for programs.
3. A command that failed is never sent again unchanged.
4. Check before you say done.
5. Answer in the user's language, in a few lines.
</mango-rules>

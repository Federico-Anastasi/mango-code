// The plan of a long job, as the harness keeps it for a conversation: a document with a step under each
// `## Step N: title` line. The text of a step is kept as the model wrote it, to give it back whole when its turn
// comes.

export type Step = { title: string; text: string; done: boolean }
export type Plan = { before: string; steps: Step[]; after: string }

const HEADING = /^##\s*Step\s*\d*\s*[:.-]?\s*(.*)$/i

/** A step as the model wrote it, with or without its heading: without one, `title` is missing. */
export function parseStep(text: string): { title?: string; text: string } {
  const [first, ...rest] = text.trim().split("\n")
  const heading = first.match(HEADING)
  return heading ? { title: heading[1].trim(), text: rest.join("\n").trim() } : { text: text.trim() }
}

export function parsePlan(text: string): Plan | undefined {
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n")
  // A line of code that begins with # inside a fenced block is not a heading.
  const fenced = lines.reduce<boolean[]>(
    (marks, line) => [...marks, /^\s*```/.test(line) !== (marks.at(-1) ?? false)],
    [],
  )
  const starts = lines.flatMap((line, i) => (HEADING.test(line) && !fenced[i] ? [i] : []))
  if (starts.length === 0) return undefined
  const closing = lines.findIndex((line, i) => i > starts[starts.length - 1] && /^#\s+\S/.test(line) && !fenced[i])
  const end = closing < 0 ? lines.length : closing
  const steps = starts.map((start, n) => {
    const step = parseStep(lines.slice(start, starts[n + 1] ?? end).join("\n"))
    return { title: step.title || `Step ${n + 1}`, text: step.text, done: false }
  })
  return { before: lines.slice(0, starts[0]).join("\n").trim(), steps, after: lines.slice(end).join("\n").trim() }
}

export const shownStep = (plan: Plan, n: number) =>
  `## Step ${n}: ${plan.steps[n - 1].title}\n${plan.steps[n - 1].text}`.trim()
export const titles = (plan: Plan) =>
  plan.steps.map((step, i) => `${i + 1}. [${step.done ? "x" : " "}] ${step.title}`).join("\n")
export const openSteps = (plan: Plan) =>
  plan.steps.flatMap((step, i) => (step.done ? [] : [`${i + 1}. ${step.title}`])).join("\n")
export const whole = (plan: Plan) =>
  [plan.before, ...plan.steps.map((_, i) => shownStep(plan, i + 1)), plan.after].filter(Boolean).join("\n")

export function goal(plan: Plan) {
  const lines = plan.before.split("\n")
  const at = lines.findIndex((line) => /^#\s*goal\s*$/i.test(line))
  if (at < 0) return undefined
  const next = lines.findIndex((line, i) => i > at && line.startsWith("#"))
  return (
    lines
      .slice(at + 1, next < 0 ? lines.length : next)
      .join(" ")
      .trim() || undefined
  )
}

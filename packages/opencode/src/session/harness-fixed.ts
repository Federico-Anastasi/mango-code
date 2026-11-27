// mango-code: the harnesses that come with Mango Code, built into the agent from `launcher/harness/`: they are the same
// wherever the agent runs, and nothing on the disk changes them.
import H1 from "../../../../launcher/harness/mango-harness-1/harness.json"
import H1_HOOKS from "../../../../launcher/harness/mango-harness-1/hooks.md" with { type: "text" }
import H1_COMPACTION from "../../../../launcher/harness/mango-harness-1/compaction.md" with { type: "text" }
import H1_PROMPT from "../../../../launcher/harness/mango-harness-1/prompt.md" with { type: "text" }
import H1_SKILL_DEBUGGING from "../../../../launcher/harness/mango-harness-1/skills/debugging.md" with { type: "text" }
import H1_SKILL_EXCEL from "../../../../launcher/harness/mango-harness-1/skills/excel.md" with { type: "text" }
import H1_SKILL_FRONTEND_DESIGN from "../../../../launcher/harness/mango-harness-1/skills/frontend-design.md" with { type: "text" }
import H1_SKILL_PDF from "../../../../launcher/harness/mango-harness-1/skills/pdf.md" with { type: "text" }
import H1_SKILL_POWERPOINT from "../../../../launcher/harness/mango-harness-1/skills/powerpoint.md" with { type: "text" }
import H1_SKILL_TEST_FIRST from "../../../../launcher/harness/mango-harness-1/skills/test-first.md" with { type: "text" }
import H1_SKILL_VERIFY_BEFORE_DONE from "../../../../launcher/harness/mango-harness-1/skills/verify-before-done.md" with { type: "text" }
import H1_SKILL_WORD from "../../../../launcher/harness/mango-harness-1/skills/word.md" with { type: "text" }
import H2 from "../../../../launcher/harness/mango-harness-2/harness.json"
import H2_HOOKS from "../../../../launcher/harness/mango-harness-2/hooks.md" with { type: "text" }
import H2_COMPACTION from "../../../../launcher/harness/mango-harness-2/compaction.md" with { type: "text" }
import H2_PROMPT from "../../../../launcher/harness/mango-harness-2/prompt.md" with { type: "text" }
import H2_TOOLS from "../../../../launcher/harness/mango-harness-2/tools.json"
import DEBUGGING from "../../../../launcher/harness/mango-harness-2/skills/debugging.md" with { type: "text" }
import DONE from "../../../../launcher/harness/mango-harness-2/skills/done.md" with { type: "text" }
import PAGE_CHECK from "../../../../launcher/harness/mango-harness-2/skills/page-check.md" with { type: "text" }
import PLANNING from "../../../../launcher/harness/mango-harness-2/skills/planning.md" with { type: "text" }
import TEST_FIRST from "../../../../launcher/harness/mango-harness-2/skills/test-first.md" with { type: "text" }
import WEB_RESEARCH from "../../../../launcher/harness/mango-harness-2/skills/web-research.md" with { type: "text" }
import TEAM_AGENT from "../../../../launcher/harness/shared/team-agent.md" with { type: "text" }
import TEAM_DEV from "../../../../launcher/harness/shared/team-dev.md" with { type: "text" }

/** The files of a harness folder: `harness.json` and `tools.json` read, the texts as they are, the skills by name. */
export type Files = {
  harness: unknown
  hooks?: string
  compaction?: string
  prompt?: string
  tools?: unknown
  skills?: Record<string, string>
}

export const FIXED: Record<string, Files> = {
  "mango-harness-1": {
    harness: H1,
    hooks: H1_HOOKS,
    compaction: H1_COMPACTION,
    prompt: H1_PROMPT,
    skills: {
      debugging: H1_SKILL_DEBUGGING,
      excel: H1_SKILL_EXCEL,
      "frontend-design": H1_SKILL_FRONTEND_DESIGN,
      pdf: H1_SKILL_PDF,
      powerpoint: H1_SKILL_POWERPOINT,
      "test-first": H1_SKILL_TEST_FIRST,
      "verify-before-done": H1_SKILL_VERIFY_BEFORE_DONE,
      word: H1_SKILL_WORD,
    },
  },
  "mango-harness-2": {
    harness: H2,
    hooks: H2_HOOKS,
    compaction: H2_COMPACTION,
    prompt: H2_PROMPT,
    tools: H2_TOOLS,
    skills: {
      debugging: DEBUGGING,
      done: DONE,
      "page-check": PAGE_CHECK,
      planning: PLANNING,
      "test-first": TEST_FIRST,
      "web-research": WEB_RESEARCH,
    },
  },
}

/** What a hidden process of the Team is told about its role (`MANGO_TEAM_ROLE`), put in the prompt of the harnesses that
 *  run the agent's own loop. They are chosen by the process's role, not by the harness. */
export const TEAM_ROLES: Record<string, string> = { dev: TEAM_DEV, agent: TEAM_AGENT }

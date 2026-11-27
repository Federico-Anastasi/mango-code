import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { PartGroup } from "@opencode-ai/session-ui/message-part"
import { Data, Equal } from "effect"
import type { TeamNoticeKind } from "./team-notice"

export type SummaryDiff = SnapshotFileDiff & { file: string }

export namespace TimelineRow {
  export class TurnGap extends Data.TaggedClass("TurnGap")<{
    userMessageID: string
  }> {}
  export class CommentStrip extends Data.TaggedClass("CommentStrip")<{
    userMessageID: string
  }> {}
  export class UserMessage extends Data.TaggedClass("UserMessage")<{
    userMessageID: string
    anchor: boolean
  }> {}
  /** What the Team put in the conversation (it was stopped, or the dev or an agent wrote to the manager): a line, not a message of the user's. */
  export class TeamNotice extends Data.TaggedClass("TeamNotice")<{
    userMessageID: string
    kind: TeamNoticeKind
    agent: string | undefined
    text: string
    excerpt: string
  }> {}
  export class TurnDivider extends Data.TaggedClass("TurnDivider")<{
    userMessageID: string
    label: "compaction" | "interrupted"
  }> {}
  /** Where the conversation was summarized in the middle of a turn. */
  export class Summarized extends Data.TaggedClass("Summarized")<{
    userMessageID: string
    messageID: string
  }> {}
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
  }> {}
  export class Thinking extends Data.TaggedClass("Thinking")<{
    userMessageID: string
    /** Since when the model gives no sign: undefined while something is moving, then the row keeps its place and says nothing. */
    since: number | undefined
    afterParts: boolean
  }> {}
  export class DiffSummary extends Data.TaggedClass("DiffSummary")<{
    userMessageID: string
    diffs: SummaryDiff[]
    /** Paths of the files that the turn's tools wrote (see produced-files.ts). */
    produced: string[]
  }> {}
  export class Error extends Data.TaggedClass("Error")<{
    userMessageID: string
    /** The conversation does not fit the model: the row shows a translated text, not the server's. */
    overflow: boolean
    /** The turn can be sent again from the row: the model closed in the middle of the answer. */
    retry: boolean
    text: string
  }> {}
  export class Retry extends Data.TaggedClass("Retry")<{
    userMessageID: string
  }> {}
  export class TurnStats extends Data.TaggedClass("TurnStats")<{
    userMessageID: string
  }> {}
  /** An answer cut for its length that the turn took up again by itself: a line where it was cut. */
  export class Resumed extends Data.TaggedClass("Resumed")<{
    userMessageID: string
    /** The message that was cut. */
    messageID: string
  }> {}
  /** An answer cut because it kept writing the same text: a line where it was cut. */
  export class Repeated extends Data.TaggedClass("Repeated")<{
    userMessageID: string
    /** The message that was cut. */
    messageID: string
  }> {}
  /** The turn ended cut for its length: a sentence, and the way to go on. `again`: it had already been taken up once. */
  export class LengthStop extends Data.TaggedClass("LengthStop")<{
    userMessageID: string
    again: boolean
  }> {}
  /** The model ended the turn without writing anything: a sentence says so instead of an empty space. */
  export class EmptyAnswer extends Data.TaggedClass("EmptyAnswer")<{
    userMessageID: string
  }> {}

  export type TimelineRow =
    | TurnGap
    | CommentStrip
    | UserMessage
    | TeamNotice
    | TurnDivider
    | AssistantPart
    | Thinking
    | DiffSummary
    | Error
    | Retry
    | TurnStats
    | Resumed
    | Repeated
    | Summarized
    | LengthStop
    | EmptyAnswer

  export const key = (row: TimelineRow) => {
    switch (row._tag) {
      case "TurnGap":
        return `turn-gap:${row.userMessageID}`
      case "CommentStrip":
        return `comment-strip:${row.userMessageID}`
      case "UserMessage":
        return `user-message:${row.userMessageID}`
      case "TeamNotice":
        return `team-notice:${row.userMessageID}`
      case "TurnDivider":
        return `turn-divider:${row.userMessageID}:${row.label}`
      case "AssistantPart":
        return `assistant-part:${row.userMessageID}:${row.group.key}`
      case "Thinking":
        return `thinking:${row.userMessageID}`
      case "DiffSummary":
        return `diff-summary:${row.userMessageID}`
      case "Error":
        return `error:${row.userMessageID}`
      case "Retry":
        return `retry:${row.userMessageID}`
      case "TurnStats":
        return `turn-stats:${row.userMessageID}`
      case "Resumed":
        return `resumed:${row.userMessageID}:${row.messageID}`
      case "Summarized":
        return `summarized:${row.userMessageID}:${row.messageID}`
      case "Repeated":
        return `repeated:${row.userMessageID}:${row.messageID}`
      case "LengthStop":
        return `length-stop:${row.userMessageID}`
      case "EmptyAnswer":
        return `empty-answer:${row.userMessageID}`
    }
  }

  export function equals(a: TimelineRow, b: TimelineRow) {
    return Equal.equals(a, b)
  }
}

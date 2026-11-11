/** The manager's agent: the same name as `agent-cfg` (team.rs, `AGENT`). */
export const TEAM_AGENT = "team"

/** The Team is on when the OpenRouter key is saved and the agent has restarted with the Team: only then the chat shows its button. */
export const teamIsOn = (info: { key: boolean } | undefined, agents: string[]) => !!info?.key && agents.includes(TEAM_AGENT)

// mango-code: the keys the app gives the agent in its environment (another PC's engine, the Team, each external
// server). The agent and its plugins read them there; the programs the model runs or that come from outside (the shell,
// the terminals of Mango Harness 2, the local MCP servers) get the environment without them.

const KEY = /^MANGO_(ENGINE_KEY|OPENROUTER_KEY|SERVER_KEY_\w+)$/i

export const withoutKeys = (env: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !KEY.test(name)))

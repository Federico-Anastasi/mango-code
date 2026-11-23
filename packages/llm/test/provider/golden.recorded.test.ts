import * as Anthropic from "../../src/providers/anthropic"
import * as OpenAI from "../../src/providers/openai"
import * as OpenAICompatible from "../../src/providers/openai-compatible"
import * as OpenRouter from "../../src/providers/openrouter"
import { describeRecordedGoldenScenarios } from "../recorded-golden"

const openAI = OpenAI.configure({
  apiKey: process.env.OPENAI_API_KEY ?? "fixture",
})
const openAIChat = openAI.chat("gpt-4o-mini")
const openAIResponses = openAI.responses("gpt-5.5")
const openAIResponsesWebSocket = openAI.responsesWebSocket("gpt-4.1-mini")
const anthropic = Anthropic.configure({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "fixture",
})
const anthropicHaiku = anthropic.model("claude-haiku-4-5-20251001")
const anthropicOpus = anthropic.model("claude-opus-4-7")
const deepseek = OpenAICompatible.deepseek
  .configure({ apiKey: process.env.DEEPSEEK_API_KEY ?? "fixture" })
  .model("deepseek-chat")
const together = OpenAICompatible.togetherai
  .configure({
    apiKey: process.env.TOGETHER_AI_API_KEY ?? "fixture",
  })
  .model("meta-llama/Llama-3.3-70B-Instruct-Turbo")
const groq = OpenAICompatible.groq
  .configure({ apiKey: process.env.GROQ_API_KEY ?? "fixture" })
  .model("llama-3.3-70b-versatile")
const openRouter = OpenRouter.configure({ apiKey: process.env.OPENROUTER_API_KEY ?? "fixture" })
const openrouter = openRouter.model("openai/gpt-4o-mini")
const openrouterGpt55 = openRouter.model("openai/gpt-5.5")
const openrouterOpus = OpenRouter.configure({
  apiKey: process.env.OPENROUTER_API_KEY ?? "fixture",
}).model("anthropic/claude-opus-4.7")

describeRecordedGoldenScenarios([
  {
    name: "OpenAI Chat gpt-4o-mini",
    prefix: "openai-chat",
    model: openAIChat,
    requires: ["OPENAI_API_KEY"],
    scenarios: ["text", "tool-call", "tool-loop", { id: "image-tool-result", maxTokens: 40 }],
  },
  {
    name: "OpenAI Responses gpt-5.5",
    prefix: "openai-responses",
    model: openAIResponses,
    requires: ["OPENAI_API_KEY"],
    tags: ["flagship"],
    scenarios: [
      { id: "text", temperature: false },
      { id: "reasoning", temperature: false },
      { id: "reasoning-continuation", temperature: false },
      { id: "tool-call", temperature: false },
      { id: "tool-loop", temperature: false },
      { id: "image-tool-result", temperature: false, maxTokens: 40 },
    ],
  },
  {
    name: "OpenAI Responses WebSocket gpt-4.1-mini",
    prefix: "openai-responses-websocket",
    model: openAIResponsesWebSocket,
    transport: "websocket",
    requires: ["OPENAI_API_KEY"],
    scenarios: ["tool-loop"],
  },
  {
    name: "Anthropic Haiku 4.5",
    prefix: "anthropic-messages",
    model: anthropicHaiku,
    requires: ["ANTHROPIC_API_KEY"],
    options: { redact: { allowRequestHeaders: ["anthropic-version"] } },
    scenarios: ["text", "tool-call"],
  },
  {
    name: "Anthropic Opus 4.7",
    prefix: "anthropic-messages",
    model: anthropicOpus,
    requires: ["ANTHROPIC_API_KEY"],
    tags: ["flagship"],
    options: { redact: { allowRequestHeaders: ["anthropic-version"] } },
    scenarios: [
      { id: "tool-loop", temperature: false },
      { id: "image-tool-result", temperature: false, maxTokens: 40 },
    ],
  },
  {
    name: "DeepSeek Chat",
    prefix: "openai-compatible-chat",
    model: deepseek,
    requires: ["DEEPSEEK_API_KEY"],
    scenarios: ["text"],
  },
  {
    name: "TogetherAI Llama 3.3 70B",
    prefix: "openai-compatible-chat",
    model: together,
    requires: ["TOGETHER_AI_API_KEY"],
    scenarios: ["text", "tool-call"],
  },
  {
    name: "Groq Llama 3.3 70B",
    prefix: "openai-compatible-chat",
    model: groq,
    requires: ["GROQ_API_KEY"],
    scenarios: ["text", "tool-call", { id: "tool-loop", timeout: 30_000 }],
  },
  {
    name: "OpenRouter gpt-4o-mini",
    prefix: "openai-compatible-chat",
    model: openrouter,
    requires: ["OPENROUTER_API_KEY"],
    scenarios: ["text", "tool-call", "tool-loop"],
  },
  {
    name: "OpenRouter gpt-5.5",
    prefix: "openai-compatible-chat",
    model: openrouterGpt55,
    requires: ["OPENROUTER_API_KEY"],
    tags: ["flagship"],
    scenarios: ["tool-loop"],
  },
  {
    name: "OpenRouter Claude Opus 4.7",
    prefix: "openai-compatible-chat",
    model: openrouterOpus,
    requires: ["OPENROUTER_API_KEY"],
    tags: ["flagship"],
    scenarios: ["tool-loop"],
  },
])

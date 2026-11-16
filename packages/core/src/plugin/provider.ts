import { AnthropicPlugin } from "./provider/anthropic"
import { CloudflareWorkersAIPlugin } from "./provider/cloudflare-workers-ai"
import { DynamicProviderPlugin } from "./provider/dynamic"
import { GithubCopilotPlugin } from "./provider/github-copilot"
import { KiloPlugin } from "./provider/kilo"
import { LLMGatewayPlugin } from "./provider/llmgateway"
import { NvidiaPlugin } from "./provider/nvidia"
import { SnowflakeCortexPlugin } from "./provider/snowflake-cortex"
import { OpenAICompatiblePlugin } from "./provider/openai-compatible"
import { OpencodePlugin } from "./provider/opencode"
import { OpenRouterPlugin } from "./provider/openrouter"
import { SapAICorePlugin } from "./provider/sap-ai-core"
import { ZenmuxPlugin } from "./provider/zenmux"
import type { PluginInternal } from "./internal"
import type { Scope } from "effect"

export const ProviderPlugins: PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>[] = [
  AnthropicPlugin,
  CloudflareWorkersAIPlugin,
  GithubCopilotPlugin,
  KiloPlugin,
  LLMGatewayPlugin,
  NvidiaPlugin,
  OpencodePlugin,
  SnowflakeCortexPlugin,
  OpenAICompatiblePlugin,
  OpenRouterPlugin,
  SapAICorePlugin,
  ZenmuxPlugin,
  DynamicProviderPlugin,
]

# Session LLM Runtime Boundaries

`../llm.ts` is the opencode session LLM service. It owns opencode concerns: auth, config, model/provider resolution, plugins, permissions and telemetry headers. It is the only file in this area that should know about the full session request shape.

This folder contains adapters behind that service boundary:

- `request.ts` prepares the request for the AI SDK: system prompt, options, parameters and headers.
- `ai-sdk.ts` converts AI SDK `fullStream` parts into `@opencode-ai/llm` `LLMEvent`s, the stream the session processor consumes.

`../llm.ts` calls `streamText(...)` locally, then adapts `result.fullStream` through `LLMAISDK`.

// What the fake engine received, as the tests read it.

import { expect } from "bun:test";
import fs from "node:fs";

export interface ChatMessage {
  role: string;
  content: unknown;
  [field: string]: unknown;
}

export interface ChatBody {
  model: string;
  messages: ChatMessage[];
  tools?: { type: string; function: { name: string; description: string } }[];
  [field: string]: unknown;
}

/** The requests to `/v1/chat/completions` in the fake engine's log, in the order they arrived. */
export function chatRequests(engineLog: string): { route: string; body: ChatBody }[] {
  return fs
    .readFileSync(engineLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((request) => request.route.startsWith("/v1/chat/completions"));
}

/** The text of a message's content, whether the agent sent a string or a list of parts. */
export function textOf(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * The system messages of a request, after checking what a model's chat template needs: exactly one, and before every other
 * message. A template that accepts only a leading system message rejects anything else.
 */
export function systemMessages(body: ChatBody): string[] {
  const system = body.messages.filter((m) => m.role === "system");
  expect(system.length).toBe(1);
  expect(body.messages[0].role).toBe("system");
  return system.map((m) => textOf(m.content));
}

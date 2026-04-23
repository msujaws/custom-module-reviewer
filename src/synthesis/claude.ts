import type { ModuleSlug } from "../util/brand.ts";
import type { ReviewBundle } from "./bundle.ts";
import { buildPrompt, type BuiltPrompt } from "./prompt.ts";

export const CLAUDE_MODEL = "claude-opus-4-7";
export const CLAUDE_MAX_TOKENS = 8000;

export interface MessagesCreateParams {
  model: string;
  max_tokens: number;
  system: BuiltPrompt["system"];
  messages: BuiltPrompt["messages"];
}

export interface MessagesCreateResponse {
  content: Array<{ type: string; text?: string }>;
}

export type MessagesCreate = (
  params: MessagesCreateParams,
) => Promise<MessagesCreateResponse>;

export const synthesizeSkill = async (
  bundle: ReviewBundle,
  moduleSlug: ModuleSlug,
  create: MessagesCreate,
): Promise<string> => {
  const prompt = buildPrompt(bundle, moduleSlug);
  const response = await create({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: prompt.system,
    messages: prompt.messages,
  });
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
};

import { describe, test, expect } from "bun:test";
import {
  synthesizeSkill,
  type MessagesCreate,
} from "../src/synthesis/claude.ts";
import { unsafeBrand, type ModuleSlug } from "../src/util/brand.ts";
import type { ReviewBundle } from "../src/synthesis/bundle.ts";

const bundle: ReviewBundle = {
  moduleHeader: "# Module: X",
  body: "Bug 1: hi\n  D1: r\n  General comments:\n  * nit",
  stats: { bugs: 1, revisions: 1, inlineComments: 0, generalComments: 1 },
};

describe("synthesizeSkill", () => {
  test("calls the Claude client with Opus 4.7 and returns the text content", async () => {
    let receivedModel = "";
    const create: MessagesCreate = async (params) => {
      receivedModel = params.model;
      return {
        content: [{ type: "text", text: "# skill body" }],
      };
    };
    const result = await synthesizeSkill(
      bundle,
      unsafeBrand<ModuleSlug>("x"),
      create,
    );
    expect(result).toBe("# skill body");
    expect(receivedModel).toBe("claude-opus-4-7");
  });

  test("joins multiple text blocks and ignores non-text blocks", async () => {
    const create: MessagesCreate = async () => ({
      content: [
        { type: "text", text: "a" },
        { type: "tool_use", text: "ignored" } as unknown as {
          type: "text";
          text: string;
        },
        { type: "text", text: "b" },
      ],
    });
    const result = await synthesizeSkill(
      bundle,
      unsafeBrand<ModuleSlug>("x"),
      create,
    );
    expect(result).toBe("ab");
  });
});

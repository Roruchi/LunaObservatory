import path from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonl } from "../src/fs/jsonl.js";
import { normalizeEventsToSession } from "../src/normalize/sessions.js";

const fixture = path.resolve("tests/fixtures/dream-multitask-codex-events.jsonl");

describe("Dream task normalization", () => {
  it("preserves ordered user and assistant text inside each Codex task turn", () => {
    const parsed = readJsonl(fixture);
    const session = normalizeEventsToSession(parsed.events, "codex", fixture, parsed.parseErrors);

    expect(parsed.parseErrors).toBe(0);
    expect(session.turns.map((turn) => turn.turnId)).toEqual(["turn-product-code", "turn-documentation"]);
    expect(session.turns.map((turn) => turn.userMessages?.map((message) => message.text))).toEqual([
      ["Update src/app.ts and verify the product build."],
      ["Update docs/guide.md and verify the documentation build."]
    ]);
    expect(session.turns.map((turn) => turn.assistantMessages.map((message) => message.text))).toEqual([
      ["Updated src/app.ts. The product build passed."],
      ["Updated docs/guide.md. The documentation build passed."]
    ]);

    expect(session.turns.map((turn) => turn.toolCalls.map((tool) => tool.toolCallId))).toEqual([
      ["product-edit", "product-build"],
      ["documentation-edit", "documentation-build"]
    ]);
    expect(session.userIntent?.text).toBe("Update src/app.ts and verify the product build.");
    expect(session.finalAnswer?.text).toBe("Updated docs/guide.md. The documentation build passed.");
  });
});

import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseSessionFile } from "../src/normalize/parser.js";
import { applyRepoFilter } from "../src/normalize/repoFilter.js";

const fixture = path.resolve("tests/fixtures/copilot-events.jsonl");

describe("repo filter", () => {
  it("includes sessions where hook cwd is inside repo", () => {
    const { session } = parseSessionFile(fixture, "copilot");
    const decision = applyRepoFilter(session, "C:\\Repo\\Personal\\LunaObservatory");
    expect(decision.repoMatch).toBe("matched");
    expect(session.repoMatch).toBe("matched");
  });
});

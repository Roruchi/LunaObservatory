import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseSessionFile } from "../src/normalize/parser.js";

const fixture = path.resolve("tests/fixtures/copilot-events.jsonl");

describe("metrics", () => {
  it("counts file views, unique file views, and repeated file views", () => {
    const { session } = parseSessionFile(fixture, "copilot");
    expect(session.metrics.filesViewed).toBe(2);
    expect(session.metrics.uniqueFilesViewed).toBe(1);
    expect(session.metrics.repeatedFileViews).toBe(1);
  });
});

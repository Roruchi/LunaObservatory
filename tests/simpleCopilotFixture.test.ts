import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSessionFile } from "../src/normalize/parser.js";

const fixtureDir = path.resolve("tests/fixtures/simple-copilot-session");
const fixture = path.join(fixtureDir, "events.jsonl");
const expectedPath = path.join(fixtureDir, "expected.json");

describe("simple copilot golden fixture", () => {
  it("matches the expected scan metrics", () => {
    const { session } = parseSessionFile(fixture, "copilot");
    const actual = {
      turns: session.metrics.turns,
      assistantMessages: session.metrics.assistantMessages,
      models: session.metrics.models,
      outputTokens: session.metrics.outputTokens,
      toolRequests: session.metrics.toolRequests,
      toolExecutionsStarted: session.metrics.toolExecutionsStarted,
      hookInvocations: session.metrics.hookInvocations,
      hookFailures: session.metrics.hookFailures,
      totalHookLatencyMs: session.metrics.totalHookLatencyMs,
      filesViewed: session.metrics.filesViewed,
      uniqueFilesViewed: session.metrics.uniqueFilesViewed,
      repeatedFileViews: session.metrics.repeatedFileViews,
      globCalls: session.metrics.globCalls,
      editCalls: session.metrics.editCalls,
      verificationEvents: session.metrics.verificationEvents,
      declaredIntents: session.metrics.declaredIntents
    };
    const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as unknown;

    expect(actual).toEqual(expected);
  });
});

import { describe, expect, it } from "vitest";
import { calculateMetrics } from "../src/normalize/metrics.js";
import type { NormalizedSession } from "../src/normalize/types.js";
import { scoreSession } from "../src/scoring/score.js";

function baseSession(partial: Partial<NormalizedSession>): NormalizedSession {
  const base = {
    sessionId: "s",
    source: "copilot" as const,
    sourceFiles: [],
    repoMatch: "matched" as const,
    lifecycleStatus: "unknown" as const,
    interactions: [],
    turns: []
  };
  const session = { ...base, ...partial } as Omit<NormalizedSession, "metrics">;
  return { ...session, metrics: calculateMetrics(session) };
}

describe("scoring", () => {
  it("adds high tool churn and missing verification reason codes", () => {
    const session = baseSession({
      turns: [
        {
          turnId: "1",
          assistantMessages: [
            {
              contentLength: 0,
              hasContent: false,
              hasEncryptedContent: false,
              hasOpaqueReasoning: false,
              outputTokens: { value: 100, source: "reported" },
              toolRequestIds: Array.from({ length: 40 }, (_, index) => `call-${index}`)
            }
          ],
          toolCalls: [{ toolCallId: "edit", name: "edit", status: "completed" }],
          hooks: []
        }
      ]
    });
    const score = scoreSession(session);
    expect(score.reasonCodes).toContain("HIGH_TOOL_CHURN");
    expect(score.reasonCodes).toContain("MISSING_VERIFICATION");
  });

  it("does not call a high-output read-only result an expensive no-op", () => {
    const session = baseSession({
      turns: [
        {
          turnId: "1",
          assistantMessages: [
            {
              contentLength: 0,
              hasContent: false,
              hasEncryptedContent: false,
              hasOpaqueReasoning: false,
              outputTokens: { value: 8000, source: "reported" },
              toolRequestIds: []
            }
          ],
          toolCalls: [],
          hooks: []
        }
      ]
    });
    expect(scoreSession(session).reasonCodes).not.toContain("EXPENSIVE_NO_OP");
  });

  it("flags a completed high-output change claim with no observed edit", () => {
    const session = baseSession({
      lifecycleStatus: "completed",
      finalAnswer: { text: "Implemented the requested fix." },
      finalClaims: [{ text: "Implemented the requested fix." }],
      turns: [
        {
          turnId: "1",
          lifecycleStatus: "completed",
          assistantMessages: [
            {
              contentLength: 30,
              hasContent: true,
              hasEncryptedContent: false,
              hasOpaqueReasoning: false,
              outputTokens: { value: 8000, source: "reported" },
              toolRequestIds: []
            }
          ],
          toolCalls: [],
          hooks: []
        }
      ]
    });
    expect(scoreSession(session).reasonCodes).toContain("EXPENSIVE_NO_OP");
  });

  it("does not treat unavailable input token telemetry as an inefficiency reason", () => {
    const session = baseSession({
      turns: [
        {
          turnId: "1",
          assistantMessages: [
            {
              contentLength: 1,
              hasContent: true,
              hasEncryptedContent: false,
              hasOpaqueReasoning: false,
              outputTokens: { value: null, source: "unavailable" },
              toolRequestIds: []
            }
          ],
          toolCalls: [],
          hooks: []
        }
      ]
    });

    expect(scoreSession(session).reasonCodes).not.toContain("UNKNOWN_INPUT_TOKENS");
  });

  it("flags repeated same-command failures but not unrelated failures", () => {
    const commands = (names: string[]) =>
      baseSession({
        turns: [
          {
            turnId: "1",
            assistantMessages: [],
            toolCalls: names.map((command, index) => ({
              toolCallId: String(index),
              name: "shell_command",
              arguments: { command, workdir: "C:\\Repo\\A" },
              status: "failed" as const
            })),
            hooks: []
          }
        ]
      });
    expect(scoreSession(commands(["npm test", "npm test", "npm test"])).reasonCodes).toContain("FAILED_COMMAND_LOOP");
    expect(scoreSession(commands(["npm test", "npm run build", "npm run lint"])).reasonCodes).not.toContain("FAILED_COMMAND_LOOP");
  });

  it("does not treat a partially completed multi-task session as a successful outcome", () => {
    const session = baseSession({
      lifecycleStatus: "completed",
      finalAnswer: { text: "Finished the last task." },
      turns: [
        { turnId: "1", lifecycleStatus: "in_progress", assistantMessages: [], toolCalls: [], hooks: [] },
        { turnId: "2", lifecycleStatus: "completed", assistantMessages: [], toolCalls: [], hooks: [] }
      ]
    });
    expect(session.metrics.taskCompletionRate).toBe(0.5);
    expect(scoreSession(session).outcomeScore).toBeLessThanOrEqual(35);
  });

  it("classifies a verified high-churn success as expensive rather than efficient", () => {
    const session = baseSession({
      lifecycleStatus: "completed",
      finalAnswer: { text: "Implemented and verified." },
      turns: [
        {
          turnId: "1",
          lifecycleStatus: "completed",
          assistantMessages: [
            {
              contentLength: 25,
              hasContent: true,
              hasEncryptedContent: false,
              hasOpaqueReasoning: false,
              outputTokens: { value: 1000, source: "reported" },
              toolRequestIds: Array.from({ length: 40 }, (_, index) => `call-${index}`)
            }
          ],
          toolCalls: [
            { toolCallId: "edit", name: "apply_patch", status: "completed" },
            { toolCallId: "test", name: "shell_command", arguments: { command: "npm test" }, status: "completed" }
          ],
          hooks: []
        }
      ]
    });
    const score = scoreSession(session);
    expect(score.reasonCodes).toContain("HIGH_TOOL_CHURN");
    expect(score.classification).toBe("expensive_but_justified");
  });
});

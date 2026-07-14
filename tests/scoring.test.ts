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
          toolCalls: [{ toolCallId: "edit", name: "edit", status: "requested" }],
          hooks: []
        }
      ]
    });
    const score = scoreSession(session);
    expect(score.reasonCodes).toContain("HIGH_TOOL_CHURN");
    expect(score.reasonCodes).toContain("MISSING_VERIFICATION");
  });

  it("adds expensive no-op reason code", () => {
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
});

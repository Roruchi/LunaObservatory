import { describe, expect, it } from "vitest";
import { analyzeDreamTasks } from "../src/dream/analyze.js";
import type {
  NormalizedAssistantMessage,
  NormalizedSession,
  NormalizedToolCall,
  NormalizedTurn,
  SessionMetrics
} from "../src/normalize/types.js";

let toolId = 0;

function tool(name: string, argumentsValue: unknown, status: NormalizedToolCall["status"] = "completed", outputText?: string): NormalizedToolCall {
  return {
    toolCallId: `${name}-${toolId++}`,
    executionCwd: "C:\\Repo\\Example",
    name,
    arguments: argumentsValue,
    status,
    outputText
  };
}

function assistant(text: string): NormalizedAssistantMessage {
  return {
    kind: "text",
    text,
    contentLength: text.length,
    hasContent: true,
    hasEncryptedContent: false,
    hasOpaqueReasoning: false,
    outputTokens: { value: null, source: "unavailable" },
    toolRequestIds: []
  };
}

function turn(id: string, request: string | undefined, tools: NormalizedToolCall[], finalAnswer?: string): NormalizedTurn {
  return {
    turnId: id,
    startedAt: `2026-07-14T0${id.length}:00:00.000Z`,
    endedAt: `2026-07-14T0${id.length}:10:00.000Z`,
    lifecycleStatus: "completed",
    userMessages: request ? [{ text: request }] : undefined,
    assistantMessages: finalAnswer ? [assistant(finalAnswer)] : [],
    toolCalls: tools,
    hooks: []
  };
}

function session(turns: NormalizedTurn[], finalAnswer?: string): NormalizedSession {
  return {
    sessionId: "session-1",
    source: "codex",
    sourceFiles: ["fixture.jsonl"],
    repoRoot: "C:\\Repo\\Example",
    repoMatch: "matched",
    startedAt: "2026-07-14T08:00:00.000Z",
    endedAt: "2026-07-14T09:00:00.000Z",
    lifecycleStatus: "completed",
    interactions: [],
    turns,
    userIntent: turns[0]?.userMessages?.[0],
    finalAnswer: finalAnswer ? { text: finalAnswer } : undefined,
    metrics: { taskStarts: turns.length } as SessionMetrics
  };
}

describe("dream task analysis", () => {
  it("classifies automation memory and closes it with post-change read-back without repository tests", () => {
    const memory = "$env:CODEX_HOME\\automations\\luna-os-v2-issue-worker\\memory.md";
    const analyzed = analyzeDreamTasks(
      session(
        [
          turn("one", "Automation: Luna OS v2 issue worker", [
            tool(
              "apply_patch",
              "*** Begin Patch\n*** Update File: C:\\Users\\roelv\\.codex\\automations\\luna-os-v2-issue-worker\\memory.md\n*** End Patch",
              "failed",
              "apply_patch verification failed: Failed to find expected lines"
            ),
            tool(
              "shell_command",
              { command: `$p=\"${memory}\"; \"## 2026-07-14\" | Add-Content -LiteralPath $p` },
              "completed",
              "Exit code: 0\nOutput:"
            ),
            tool(
              "shell_command",
              { command: `Get-Content -Tail 14 ${memory}` },
              "completed",
              "Exit code: 0\nOutput:\n## 2026-07-14\n- No issue was selected."
            ),
            tool("shell_command", { command: "git status --short --branch" }, "completed", "## HEAD (no branch)")
          ])
        ],
        "No repository files were changed. I updated the automation memory."
      )
    )[0];

    const failedPatch = analyzed.changes.find((change) => change.evidence.some((item) => item === "effectiveOutcome=failed"));
    const memoryChange = analyzed.changes.find((change) => change.changeType === "automation_memory" && change.stateChanging);
    const readBack = analyzed.verificationChecks.find((check) => check.verificationType === "read_back");
    expect(failedPatch?.stateChanging).toBe(false);
    expect(memoryChange).toMatchObject({ verificationRequired: true, repositoryTestsRelevant: false });
    expect(readBack).toMatchObject({ status: "passed", fresh: true });
  });

  it("classifies inspection-only tool activity as read-only", () => {
    const analyzed = analyzeDreamTasks(session([turn("one", "Inspect the implementation.", [tool("read_file", { path: "src/app.ts" })])]))[0];
    expect(analyzed.changes).toEqual([
      expect.objectContaining({ changeType: "read_only", stateChanging: false, verificationRequired: false })
    ]);
  });

  it("leaves an unsupported PowerShell conditional without verification credit", () => {
    const analyzed = analyzeDreamTasks(
      session([
        turn("one", "Inspect the automation memory.", [
          tool("shell_command", {
            command:
              'if (Test-Path "C:\\Users\\roelv\\.codex\\automations\\luna-os-v2-issue-worker\\memory.md") { Get-Content "C:\\Users\\roelv\\.codex\\automations\\luna-os-v2-issue-worker\\memory.md" }'
          })
        ])
      ])
    )[0];

    // The conditional's execution and read target are outside the bounded shell grammar.
    expect(analyzed.verificationChecks).toEqual([]);
  });

  it("accepts a fresh build after a product-code edit", () => {
    const analyzed = analyzeDreamTasks(
      session([
        turn("one", "Change the application.", [
          tool("apply_patch", "*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch", "completed", "Success"),
          tool("shell_command", { command: "npm run build", workdir: "C:\\Repo\\Example" }, "completed", "Exit code: 0")
        ])
      ])
    )[0];
    expect(analyzed.changes).toContainEqual(expect.objectContaining({ changeType: "product_code", stateChanging: true }));
    expect(analyzed.verificationChecks).toContainEqual(expect.objectContaining({ verificationType: "build", status: "passed", fresh: true }));
  });

  it("does not treat a test before the final product-code edit as fresh", () => {
    const analyzed = analyzeDreamTasks(
      session([
        turn("one", "Change the application.", [
          tool("shell_command", { command: "npm test", workdir: "C:\\Repo\\Example" }, "completed", "Exit code: 0"),
          tool("apply_patch", "*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch", "completed", "Success")
        ])
      ])
    )[0];
    expect(analyzed.verificationChecks).toContainEqual(expect.objectContaining({ verificationType: "test", fresh: false }));
  });

  it("accepts a document build after a documentation edit", () => {
    const analyzed = analyzeDreamTasks(
      session([
        turn("one", "Update the guide.", [
          tool("apply_patch", "*** Begin Patch\n*** Update File: docs/guide.md\n*** End Patch", "completed", "Success"),
          tool("shell_command", { command: "node scripts/build-docs.js" }, "completed", "Exit code: 0")
        ])
      ])
    )[0];
    expect(analyzed.changes).toContainEqual(
      expect.objectContaining({ changeType: "documentation", repositoryTestsRelevant: false })
    );
    expect(analyzed.verificationChecks).toContainEqual(
      expect.objectContaining({ verificationType: "document_build", status: "passed", fresh: true })
    );
  });

  it("accepts external-system confirmation after a matching UI mutation", () => {
    const analyzed = analyzeDreamTasks(
      session([
        turn("one", "Save the external form.", [
          tool("browser_click", { resourceId: "form-1", label: "Save" }),
          tool("browser_screenshot", { resourceId: "form-1" })
        ])
      ])
    )[0];
    expect(analyzed.changes).toContainEqual(expect.objectContaining({ changeType: "external_system", stateChanging: true }));
    expect(analyzed.verificationChecks).toContainEqual(
      expect.objectContaining({ verificationType: "external_confirmation", status: "passed", fresh: true })
    );
  });

  it("keeps changes and verification inside their user-message task windows", () => {
    const analyzed = analyzeDreamTasks(
      session([
        turn(
          "one",
          "Update the guide.",
          [
            tool("apply_patch", "*** Begin Patch\n*** Update File: docs/guide.md\n*** End Patch", "completed", "Success"),
            tool("shell_command", { command: "node scripts/build-docs.js" }, "completed", "Exit code: 0")
          ],
          "The guide was updated."
        ),
        turn(
          "two",
          "Fix the application.",
          [
            tool("apply_patch", "*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch", "completed", "Success"),
            tool("shell_command", { command: "npm run build" }, "completed", "Exit code: 0")
          ],
          "The application was fixed."
        )
      ], "The application was fixed.")
    );
    expect(analyzed).toHaveLength(2);
    expect(analyzed[0].changes).toContainEqual(expect.objectContaining({ changeType: "documentation" }));
    expect(analyzed[0].verificationChecks).toContainEqual(expect.objectContaining({ verificationType: "document_build", fresh: true }));
    expect(analyzed[1].changes).toContainEqual(expect.objectContaining({ changeType: "product_code" }));
    expect(analyzed[1].verificationChecks).toContainEqual(expect.objectContaining({ verificationType: "build", fresh: true }));
    expect(analyzed[0].finalAnswer).toBe("The guide was updated.");
  });

  it("keeps an ambiguous completed edit as unknown with low confidence", () => {
    const analyzed = analyzeDreamTasks(session([turn("one", "Make the requested change.", [tool("apply_patch", "unstructured edit")])]))[0];
    expect(analyzed.changes).toContainEqual(
      expect.objectContaining({ changeType: "unknown", stateChanging: true, confidence: "low", verificationRequired: null })
    );
  });
});

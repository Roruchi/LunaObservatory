import fs from "node:fs";
import path from "node:path";

export type SkillAgent = "codex" | "copilot" | "claude" | "all" | "canonical";

export const dreamSkillMarkdown = `---
name: lunaobs-dream
description: Run LunaObs dream mode as an offline frozen-evidence evaluation workflow for scanned coding-agent sessions.
---

# LunaObs Dream Mode Skill

Use this skill when the user asks to evaluate, review, judge, compare, or learn from one or more LunaObs-scanned agent sessions.

Dream mode is an offline evaluation workflow. Humans usually trigger dream mode, but an AI coding or review agent executes this skill safely and consistently.

Scan gathers evidence. Dream evaluates frozen scan evidence. Dream mode does not gather new evidence.

## Use this skill when

Use this skill when asked about:

- intent adherence
- ignored or weakened instructions
- unsupported final-answer claims
- verification quality
- efficiency or wasted effort
- comparison between efficient and inefficient sessions
- lessons for future coding-agent runs

## Inputs

Expected inputs:

- path to a LunaObs scan packet, scan directory, or prepared dream directory
- optional output directory or report path
- optional focus area, such as intent adherence, ignored instructions, unsupported claims, verification quality, efficiency, or efficient versus inefficient session comparison

If the scan packet location is obvious, do not ask the user unnecessary questions. Use the obvious packet or directory.

## Workflow

1. Confirm or locate the scan packet.
2. Prepare the frozen dream packet:

\`\`\`bash
lunaobs dream prepare --input <scan-path> --out <dream-dir>
\`\`\`

3. Validate the prepared packet:

\`\`\`bash
lunaobs dream validate --input <dream-dir> --out <dream-dir>/report.md
\`\`\`

4. Read the generated Markdown report.
5. Summarize the dream result for the user, including which sessions were inspected and what concrete repo/process changes should be made.

## Strict rules

- Do not inspect the live repository during dream validation.
- Do not run tests unless they are part of the dream tooling itself.
- Do not use git history unless it is already included in the scan packet.
- Do not infer facts from files outside the scan packet.
- Do not claim something was verified unless the packet contains verification evidence.
- Do not hide missing evidence.
- Do not treat low-confidence findings as certain.
- Do not turn the report into generic coaching. Every finding must be grounded in packet evidence.
- Do not modify application source code or apply fixes as part of dream mode.
- Do not call network services to fill evidence gaps.

## Frozen-evidence boundary

Dream mode evaluates frozen scan evidence.

The agent may run \`lunaobs dream prepare\`, run \`lunaobs dream validate\`, and read the generated dream artifacts.

The agent must not inspect the live repository to fill in gaps during dream validation. The scan packet is the source of truth.

Missing packet evidence lowers confidence or becomes a missing-evidence note. It does not authorize extra investigation.

## Handling incomplete evidence

- If original intent is missing, say intent adherence cannot be fully evaluated.
- If explicit instructions are missing, say ignored-instruction review is limited.
- If final-answer text or claim extraction is missing, do not invent unsupported claims.
- If test or build output is missing, say verification was not proven by the packet.
- If efficient comparison sessions are missing, do not force an efficiency comparison.

## Avoiding unsupported claims

- Prefer phrases such as "the packet shows", "the report flags", and "evidence is missing".
- Avoid phrases such as "the agent definitely fixed", "tests passed", or "the repo contained" unless the packet contains that evidence.
- Keep low-confidence observations separate from evidence-backed findings.

## Output style

When reporting back to the user, use this structure:

## Dream result

Brief overall judgment.

## Main findings

List the most important findings with severity.

## Inspected sessions

List every inspected session ID with role, classification, tool count, edits, verification passed/failed, failed commands, and reason codes. Do not make the user open raw JSON to know what was evaluated.

## Ignored instructions

Call out explicit instructions that were followed, weakened, or violated.

## Unsupported claims

Call out claims the agent made that are not supported by packet evidence.

## Verification gaps

Explain what was verified and what was not.

## Efficiency lessons

Compare efficient and inefficient sessions when comparison data exists.

## Recommendations

Give practical improvements for future agent runs. Recommendations must name a target such as \`AGENTS.md\`, a skill file, a runbook, scan capture fields, or validation tooling. They should be specific enough for a follow-up apply agent to implement without guessing the intent.

## Dream apply backlog

List exact follow-up edits an apply agent should make, such as adding an AGENTS.md verification rule, adding retry discipline after repeated failed commands, updating a Satori verification skill, or improving LunaObs scan capture.

## Missing evidence

Mention anything that could not be evaluated because the scan packet lacked evidence.
`;

const outputContractMarkdown = `# LunaObs Dream Output Contract

Dream validation writes a Markdown report from a prepared \`dream-pack.json\`.

Default flow:

\`\`\`bash
lunaobs dream prepare --input <scan-path> --out <dream-dir>
lunaobs dream validate --input <dream-dir> --out <dream-dir>/report.md
\`\`\`

Every finding needs severity, category, explanation, evidence references, confidence, and a suggested improvement.

The generated report must clearly separate evidence-backed findings, low-confidence observations, missing evidence, and recommendations.

The report must list inspected sessions and include concrete follow-up targets such as \`AGENTS.md\`, a skill file, a runbook, scan capture fields, or validation tooling. A follow-up apply agent should be able to act from the recommendations without guessing.
`;

const investigationRulesMarkdown = `# LunaObs Dream Investigation Rules

- Start from \`dream-pack.json\`.
- Treat the prepared dream packet as the only source of truth.
- Do not inspect the live repository during validation.
- Do not run git, tests, builds, or source-file reads to fill evidence gaps.
- Do not copy encrypted content or opaque reasoning into outputs.
- Do not modify application source code or apply fixes.
- Do not claim verification unless the packet contains verification evidence.
- Keep missing evidence visible.
`;

function targetRoots(repoRoot: string, agent: SkillAgent): string[] {
  const map: Record<Exclude<SkillAgent, "all">, string> = {
    canonical: path.join(repoRoot, ".lunaobs", "skills"),
    codex: path.join(repoRoot, ".agents", "skills"),
    copilot: path.join(repoRoot, ".github", "skills"),
    claude: path.join(repoRoot, ".claude", "skills")
  };
  if (agent === "all") return [map.codex, map.copilot, map.claude];
  return [map[agent]];
}

export function installDreamSkill(repoRoot: string, agent: SkillAgent = "canonical"): string[] {
  const installed: string[] = [];
  for (const root of targetRoots(repoRoot, agent)) {
    const skillDir = path.join(root, "lunaobs-dream");
    const resourcesDir = path.join(skillDir, "resources");
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), dreamSkillMarkdown, "utf8");
    fs.writeFileSync(path.join(resourcesDir, "output-contract.md"), outputContractMarkdown, "utf8");
    fs.writeFileSync(path.join(resourcesDir, "investigation-rules.md"), investigationRulesMarkdown, "utf8");
    installed.push(skillDir);
  }
  return installed;
}

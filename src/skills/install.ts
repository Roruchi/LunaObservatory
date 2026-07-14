import fs from "node:fs";
import path from "node:path";

export type SkillAgent = "codex" | "copilot" | "claude" | "all" | "canonical";

export const dreamSkillMarkdown = `---
name: lunaobs-dream
description: Run LunaObs dream mode as an offline frozen-evidence evaluation workflow for scanned coding-agent sessions. Use when evaluating intent or instruction adherence, unsupported final claims, verification closure, recovery behavior, redundant work, or lessons from efficient and risky agent runs.
---

# LunaObs Dream Mode Skill

Use this skill when the user asks to evaluate, review, judge, compare, or learn from one or more LunaObs-scanned agent sessions.

Dream mode is an offline evaluation workflow. Humans usually trigger dream mode, but an AI coding or review agent executes this skill safely and consistently.

Scan gathers evidence. Dream evaluates frozen scan evidence. Dream mode does not gather new evidence.

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

4. Read \`report.md\` first. Use \`details.md\` when a decision needs session/task traceability, and use \`apply-plan.json\` for follow-up work.
5. Summarize the decision, the strongest repeated patterns, and only the concrete changes justified by the evidence.

## Strict rules

- Do not inspect the live repository during dream validation.
- Do not run tests unless they are part of the dream tooling itself.
- Do not use git history unless it is already included in the scan packet.
- Do not infer facts from files outside the scan packet.
- Do not claim something was verified unless the packet contains verification evidence.
- Do not hide missing evidence.
- Do not treat low-confidence findings as certain.
- Do not turn the report into generic coaching. Every finding must be grounded in packet evidence.
- Do not treat every edit-shaped tool call as a repository code change. Use the task-local change classification and effective outcome in the packet.
- Do not report missing verification unless the task had an eligible successful state change and lacked a fresh matching check after its final relevant change.
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
- If task segmentation or change classification is low confidence, route the observation to human review instead of asserting a high-confidence gap.
- Treat read-only work as not requiring change verification. Match documentation, external-state, generated-artifact, and automation-memory work to proportionate checks such as document build, external confirmation, artifact inspection, persistence check, or read-back.
- If efficient comparison sessions are missing, do not force an efficiency comparison.
- If an instruction status is unknown, report it as unknown or \`insufficient\`; never count missing evidence as compliance.
- Compare task-normalized effort only directionally when task difficulty or repository context differs.

## Avoiding unsupported claims

- Prefer phrases such as "the packet shows", "the report flags", and "evidence is missing".
- Avoid phrases such as "the agent definitely fixed", "tests passed", or "the repo contained" unless the packet contains that evidence.
- Keep low-confidence observations separate from evidence-backed findings.

## Output style

Use the generated decision report as the default human-facing structure. Keep the summary compact and follow its labels:

## Dream result

Brief overall judgment.

## Main findings

List the most important grouped patterns with severity and one of: reliable finding, possible false positive, guidance, or human review.

## Inspected sessions

Link or point to \`details.md\` for the full inspected-session and task table. Keep the main result readable; retain session IDs and evidence references in the appendix for auditability.

## Ignored instructions

Call out explicit instructions that were followed, weakened, or violated.

## Unsupported claims

Call out claims the agent made that are not supported by packet evidence.

## Verification gaps

Explain what was verified and what was not.

## Efficiency lessons

Compare efficient and inefficient sessions when comparison data exists.

## Recommendations

Give proportional improvements for future agent runs. A single low-confidence observation should usually produce no durable rule, a repeated repository-local pattern may justify repository guidance, and only a repeated cross-repository pattern should propose shared guidance.

## Dream apply backlog

Summarize the action classes in \`apply-plan.json\`: \`safe_guidance_update\`, \`analyzer_improvement\`, \`repository_specific_investigation\`, \`no_action\`, or \`human_review_required\`. Do not apply the backlog during Dream evaluation.

## Missing evidence

Mention anything that could not be evaluated because the scan packet lacked evidence.
`;

const outputContractMarkdown = `# LunaObs Dream Output Contract

Dream validation writes four decision artifacts from a prepared \`dream-pack.json\`:

- \`report.md\`: compact grouped human decision report
- \`report.html\`: readable HTML equivalent
- \`details.md\`: session/task traceability appendix
- \`apply-plan.json\`: machine-readable follow-up plan

Default flow:

\`\`\`bash
lunaobs dream prepare --input <scan-path> --out <dream-dir>
lunaobs dream validate --input <dream-dir> --out <dream-dir>/report.md
\`\`\`

Every finding needs a stable finding ID and pattern key, severity, category, disposition, task identity, observation, interpretation, alternative explanation, recommended action, apply target, confidence, and evidence references. Observed facts and inferred interpretation must remain separate.

The generated report must clearly label reliable findings, possible false positives, guidance, and human-review items. Repeated findings should be grouped by pattern, with the full per-session evidence retained in \`details.md\`.

Missing-verification findings are eligible only for task-local successful state changes that require verification and have no fresh matching check after the final relevant change. Read-only work is ineligible. Unknown or low-confidence classification must not become a high-confidence gap.

The apply plan must choose one proportional action class: \`safe_guidance_update\`, \`analyzer_improvement\`, \`repository_specific_investigation\`, \`no_action\`, or \`human_review_required\`. It must name exact targets and evidence so a follow-up agent can act without guessing, while avoiding durable policy from isolated low-confidence observations.
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

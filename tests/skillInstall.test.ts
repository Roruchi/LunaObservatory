import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dreamSkillMarkdown, installDreamSkill } from "../src/skills/install.js";

describe("skill install", () => {
  it("copies the skill file to the selected target directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-skill-"));
    installDreamSkill(root, "codex");
    expect(fs.existsSync(path.join(root, ".agents", "skills", "lunaobs-dream", "SKILL.md"))).toBe(true);
  });

  it("keeps the installed skill text in sync with the canonical skill", () => {
    const canonical = fs.readFileSync(path.resolve("src/skills/lunaobs-dream/SKILL.md"), "utf8").trim();
    expect(dreamSkillMarkdown.trim()).toBe(canonical);
  });
});

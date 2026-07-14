import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type LunaObsPaths = {
  root: string;
  lunaobs: string;
  index: string;
  reports: string;
  dream: string;
  dreamOutput: string;
  skills: string;
};

export function homePath(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

export function detectRepoRoot(cwd = process.cwd()): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    shell: false
  });
  if (result.status === 0 && result.stdout.trim()) {
    return path.resolve(result.stdout.trim());
  }
  return path.resolve(cwd);
}

export function getLunaObsPaths(root = process.cwd(), out = ".lunaobs"): LunaObsPaths {
  const lunaobs = path.resolve(root, out);
  return {
    root: path.resolve(root),
    lunaobs,
    index: path.join(lunaobs, "index"),
    reports: path.join(lunaobs, "reports"),
    dream: path.join(lunaobs, "dream"),
    dreamOutput: path.join(lunaobs, "dream", "output"),
    skills: path.join(lunaobs, "skills")
  };
}

export function ensureLunaObsDirs(paths: LunaObsPaths): void {
  for (const dir of [paths.lunaobs, paths.index, paths.reports, paths.dream, paths.dreamOutput, paths.skills]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

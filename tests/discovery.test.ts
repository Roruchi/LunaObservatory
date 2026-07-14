import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSources } from "../src/fs/discovery.js";

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("Copilot discovery", () => {
  it("finds session-state events and jb partition logs", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lunaobs-copilot-"));
    const sessionDir = path.join(tempRoot, "session-state", "session-1");
    const jbDir = path.join(tempRoot, "jb", "session-2");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(jbDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "events.jsonl"), "\n", "utf8");
    fs.writeFileSync(path.join(jbDir, "partition-1.jsonl"), "\n", "utf8");

    const [source] = discoverSources("copilot", tempRoot);

    expect(source.files.map((file) => path.basename(file)).sort()).toEqual(["events.jsonl", "partition-1.jsonl"]);
  });
});

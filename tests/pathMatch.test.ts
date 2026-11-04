import { describe, expect, it } from "vitest";
import { isPathInside, repositoryRootForPath } from "../src/utils/pathMatch.js";

describe("cross-platform transcript paths", () => {
  it.each([
    ["C:\\Repo\\Example\\Project\\src", "c:/repo/example/project", true],
    ["C:\\Repo\\Example\\Project-other", "C:\\Repo\\Example\\Project", false],
    ["D:\\Repo\\Example\\Project", "C:\\Repo\\Example\\Project", false],
    ["\\\\server\\share\\project\\src", "\\\\server\\share\\project", true],
    ["\\\\server\\other\\project", "\\\\server\\share\\project", false]
  ])("matches %s against %s as %s", (child, parent, expected) => {
    expect(isPathInside(child, parent)).toBe(expected);
  });

  it("infers a Windows repository without consulting the scanner checkout", () => {
    expect(repositoryRootForPath("C:\\Repo\\Example\\Project\\src")).toBe("C:\\Repo\\Example\\Project");
  });

  it("leaves foreign paths with no known repository shape unresolved", () => {
    expect(repositoryRootForPath("Z:\\unavailable\\project\\src")).toBeUndefined();
  });
});

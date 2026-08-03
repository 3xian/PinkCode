import { describe, expect, it } from "vitest";
import {
  buildPartialPatch,
  parseHunkStart,
  parseUnifiedDiff,
} from "./gitDiffHunks";

const SAMPLE = `diff --git a/foo.txt b/foo.txt
index 111..222 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,4 @@
 line1
-line2
+line2-edited
 line3
+line4
@@ -10,2 +11,2 @@
 keep
-old
+new
`;

describe("parseUnifiedDiff", () => {
  it("splits file header and hunks", () => {
    const p = parseUnifiedDiff(SAMPLE);
    expect(p.empty).toBe(false);
    expect(p.fileHeader).toContain("diff --git");
    expect(p.fileHeader).toContain("--- a/foo.txt");
    expect(p.hunks).toHaveLength(2);
    expect(p.hunks[0]!.header).toMatch(/^@@ -1,3 \+1,4 @@/);
    expect(p.hunks[0]!.added).toBe(2);
    expect(p.hunks[0]!.removed).toBe(1);
    expect(p.hunks[0]!.oldStart).toBe(1);
    expect(p.hunks[0]!.newStart).toBe(1);
    expect(p.hunks[1]!.added).toBe(1);
    expect(p.hunks[1]!.removed).toBe(1);
    expect(p.hunks[1]!.oldStart).toBe(10);
    expect(p.hunks[1]!.newStart).toBe(11);
  });

  it("defaults hunk start to 1 when count is omitted", () => {
    const p = parseUnifiedDiff("@@ -1 +2 @@\nold\n+new\n");
    expect(p.hunks[0]!.oldStart).toBe(1);
    expect(p.hunks[0]!.newStart).toBe(2);
  });

  it("classifies hunk content lines with prefix stripped", () => {
    const p = parseUnifiedDiff(SAMPLE);
    expect(p.hunks[0]!.lines).toEqual([
      { tag: "equal", text: "line1" },
      { tag: "delete", text: "line2" },
      { tag: "insert", text: "line2-edited" },
      { tag: "equal", text: "line3" },
      { tag: "insert", text: "line4" },
    ]);
  });

  it("keeps \\ No newline markers as meta lines without counting them", () => {
    const p = parseUnifiedDiff(
      "@@ -1,2 +1,2 @@\n-a\n+b\n\\ No newline at end of file\n",
    );
    expect(p.hunks[0]!.lines).toEqual([
      { tag: "delete", text: "a" },
      { tag: "insert", text: "b" },
      { tag: "meta", text: "\\ No newline at end of file" },
    ]);
    expect(p.hunks[0]!.added).toBe(1);
    expect(p.hunks[0]!.removed).toBe(1);
  });

  it("handles empty diff", () => {
    expect(parseUnifiedDiff("").empty).toBe(true);
    expect(parseUnifiedDiff("   ").empty).toBe(true);
  });
});

describe("parseHunkStart", () => {
  it("extracts old/new start lines from a header", () => {
    expect(parseHunkStart("@@ -4,3 +9,2 @@")).toEqual({
      oldStart: 4,
      newStart: 9,
    });
    expect(parseHunkStart("@@ -0,0 +1,5 @@")).toEqual({
      oldStart: 0,
      newStart: 1,
    });
  });

  it("falls back to 1 on unparseable headers", () => {
    expect(parseHunkStart("not a hunk")).toEqual({ oldStart: 1, newStart: 1 });
  });
});

describe("buildPartialPatch", () => {
  it("rebuilds a patch with only selected hunks", () => {
    const p = parseUnifiedDiff(SAMPLE);
    const patch = buildPartialPatch(p, [1]);
    expect(patch).toBeTruthy();
    expect(patch!).toContain("diff --git");
    expect(patch!).toContain("@@ -10,2 +11,2 @@");
    expect(patch!).not.toContain("@@ -1,3 +1,4 @@");
  });

  it("returns null when nothing selected", () => {
    const p = parseUnifiedDiff(SAMPLE);
    expect(buildPartialPatch(p, [])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { buildPartialPatch, parseUnifiedDiff } from "./gitDiffHunks";

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
    expect(p.hunks[1]!.added).toBe(1);
    expect(p.hunks[1]!.removed).toBe(1);
  });

  it("handles empty diff", () => {
    expect(parseUnifiedDiff("").empty).toBe(true);
    expect(parseUnifiedDiff("   ").empty).toBe(true);
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

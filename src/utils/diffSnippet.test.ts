import { describe, expect, it } from "vitest";
import { buildDiffSnippet } from "./diffSnippet";

const PATCH = `@@ -4,3 +4,3 @@
 let x = 1;
-const y = 2;
+const y = 3;
 z
@@ -20,1 +21,1 @@
-old
+new
`;

describe("buildDiffSnippet", () => {
  it("maps hunks to header + numbered content rows", () => {
    const s = buildDiffSnippet(PATCH);
    expect(s).not.toBeNull();
    const rows = s!.rows;
    expect(rows[0]).toEqual({ tag: "hunk", text: "@@ -4,3 +4,3 @@" });
    expect(rows[1]).toEqual({
      tag: "equal",
      oldLine: 4,
      newLine: 4,
      // The unified-diff space prefix is stripped; the sign column renders it.
      text: "let x = 1;",
    });
    expect(rows[2]).toEqual({
      tag: "delete",
      oldLine: 5,
      text: "const y = 2;",
    });
    expect(rows[3]).toEqual({
      tag: "insert",
      newLine: 5,
      text: "const y = 3;",
    });
    expect(rows[4]).toEqual({
      tag: "equal",
      oldLine: 6,
      newLine: 6,
      text: "z",
    });
    // Second hunk continues numbering from its own header.
    expect(rows[5]).toEqual({ tag: "hunk", text: "@@ -20,1 +21,1 @@" });
    expect(rows[6]).toEqual({ tag: "delete", oldLine: 20, text: "old" });
    expect(rows[7]).toEqual({ tag: "insert", newLine: 21, text: "new" });
    expect(s!.truncated).toBe(false);
  });

  it("returns null for non-diff text", () => {
    expect(buildDiffSnippet("plain tool output")).toBeNull();
    expect(buildDiffSnippet("")).toBeNull();
  });

  it("handles header-count-omitted hunks", () => {
    const s = buildDiffSnippet("@@ -1 +2 @@\n-old\n+new\n");
    expect(s!.rows[1]).toEqual({ tag: "delete", oldLine: 1, text: "old" });
    expect(s!.rows[2]).toEqual({ tag: "insert", newLine: 2, text: "new" });
  });

  it("renders \\ No newline markers as unnumbered context rows", () => {
    const s = buildDiffSnippet(
      "@@ -1,2 +1,2 @@\n-a\n+b\n\\ No newline at end of file\n",
    );
    expect(s!.rows[3]).toEqual({
      tag: "equal",
      text: "\\ No newline at end of file",
    });
    expect(s!.rows[3]).not.toHaveProperty("oldLine");
    expect(s!.rows[3]).not.toHaveProperty("newLine");
  });

  it("truncates only between hunks", () => {
    const big = Array.from(
      { length: 500 },
      (_, i) => `@@ -${i * 2 + 1},1 +${i * 2 + 1},1 @@\n-old\n+new\n`,
    ).join("");
    const s = buildDiffSnippet(big);
    expect(s!.truncated).toBe(true);
    // Only whole hunks are kept: each is exactly 3 rows (header + 2 lines),
    // and 133 × 3 = 399 stays under the 400-row cap while 134 would exceed it.
    expect(s!.rows.length % 3).toBe(0);
    expect(s!.rows.length).toBe(399);
  });
});

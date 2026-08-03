import { describe, expect, it } from "vitest";
import { extractEditDiff, isEditToolUpdate } from "./editDiff";

describe("isEditToolUpdate", () => {
  it("detects Edit kind and edit-class tool names", () => {
    // ACP ToolKind serializes lowercase on the wire ("kind":"edit").
    expect(isEditToolUpdate({ kind: "edit", title: "Edit `src/a.ts`" })).toBe(true);
    expect(isEditToolUpdate({ kind: "Edit", title: "Edit `src/a.ts`" })).toBe(true);
    expect(isEditToolUpdate({ kind: "read", title: "Read `src/a.ts`" })).toBe(false);
    expect(
      isEditToolUpdate({
        kind: "Other",
        _meta: { "x.ai/tool": { name: "search_replace" } },
      }),
    ).toBe(true);
    expect(
      isEditToolUpdate({
        kind: "Other",
        _meta: { "x.ai/tool": { name: "apply_patch" } },
      }),
    ).toBe(true);
    expect(
      isEditToolUpdate({
        kind: "Other",
        _meta: { "x.ai/tool": { name: "run_terminal_command" } },
      }),
    ).toBe(false);
  });
});

describe("extractEditDiff", () => {
  it("builds a unified diff from SearchReplace rawOutput details", () => {
    const diff = extractEditDiff({
      kind: "Edit",
      title: "Edit `src/main.ts`",
      rawOutput: {
        type: "SearchReplace",
        EditsApplied: {
          old_string: "let x = 1;",
          new_string: "let x = 2;",
          absolute_path: "/tmp/main.ts",
          edits: {
            details: [
              {
                old_string: "let x = 1;",
                new_string: "let x = 2;",
                old_line: 5,
                new_line: 5,
                context_before: "fn main() {\n",
                context_after: "}",
                line_prefix: "",
              },
            ],
          },
        },
      },
    });
    // Hunk starts at the first shown old line — the context line at 4.
    expect(diff).toContain("@@ -4,3 +4,3 @@");
    expect(diff).toContain("-let x = 1;");
    expect(diff).toContain("+let x = 2;");
    expect(diff).toContain(" fn main() {");
  });

  it("accepts snake_case raw_output too (disk hydrate tolerance)", () => {
    const diff = extractEditDiff({
      kind: "Edit",
      raw_output: {
        type: "SearchReplace",
        EditsApplied: {
          edits: {
            details: [
              {
                old_string: "a",
                new_string: "b",
                old_line: 1,
                new_line: 1,
              },
            ],
          },
        },
      },
    });
    expect(diff).toContain("-a");
    expect(diff).toContain("+b");
  });

  it("falls back to content diff blocks (write tool full content)", () => {
    const diff = extractEditDiff({
      kind: "Edit",
      title: "Write `src/out.txt`",
      content: [
        {
          type: "diff",
          path: "src/out.txt",
          new_text: "hello\nworld\n",
        },
      ],
    });
    // Pure insertion: zero old lines ("-1,0"), two new lines.
    expect(diff).toContain("@@ -1,0 +1,2 @@");
    expect(diff).toContain("+hello");
    expect(diff).toContain("+world");
  });

  it("renders replacements against the old text via LCS alignment", () => {
    const diff = extractEditDiff({
      kind: "Edit",
      content: [
        {
          type: "diff",
          path: "x.txt",
          old_text: "keep\nremove\nkeep2\n",
          new_text: "keep\nadded\nkeep2\n",
        },
      ],
    });
    expect(diff).toContain("-remove");
    expect(diff).toContain("+added");
    expect(diff).toContain(" keep");
  });

  it("returns undefined for non-edit output", () => {
    expect(
      extractEditDiff({ kind: "Read", rawOutput: { type: "ReadFile" } }),
    ).toBeUndefined();
    expect(
      extractEditDiff({
        kind: "Edit",
        rawOutput: { type: "Bash", output: [], exit_code: 0 },
      }),
    ).toBeUndefined();
  });
});

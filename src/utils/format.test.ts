import { describe, expect, it } from "vitest";
import {
  describeUpdate,
  formatToolCardTitle,
  isToolCallId,
  mergeToolTitles,
  splitToolTitle,
  toolTitleBaseQuality,
} from "./format";

describe("friendly tool titles", () => {
  it("detects call ids", () => {
    expect(isToolCallId("call-ba1b17dc-202a-4ed7-bd88-e0bfe9cd69af-4")).toBe(
      true,
    );
    expect(isToolCallId("Read `attribution.py`")).toBe(false);
  });

  it("formats initial tool_call with label + path", () => {
    const { title, detail } = formatToolCardTitle({
      sessionUpdate: "tool_call",
      toolCallId: "call-f8b05138-361f-4d22-96a9-d3d94930cd93-0",
      title: "read_file",
      rawInput: {
        target_file:
          "C:\\Users\\Administrator\\.grok\\skills\\imagine\\SKILL.md",
        limit: 80,
      },
      _meta: {
        "x.ai/tool": {
          name: "read_file",
          label: "Read",
          kind: "read",
        },
      },
    });
    expect(title).toBe("Read `…/imagine/SKILL.md`");
    expect(title).not.toMatch(/^call-/);
    expect(detail).toBeUndefined();
  });

  it("keeps ACP human title on tool_call_update", () => {
    const { title } = formatToolCardTitle({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-f8b05138-361f-4d22-96a9-d3d94930cd93-0",
      title:
        "Read `C:\\Users\\Administrator\\.grok\\skills\\imagine\\SKILL.md`",
      kind: "read",
      locations: [
        {
          path: "C:\\Users\\Administrator\\.grok\\skills\\imagine\\SKILL.md",
        },
      ],
    });
    expect(title).toContain("Read `");
    expect(title).toContain("SKILL.md");
    expect(isToolCallId(splitToolTitle(title).base)).toBe(false);
  });

  it("status-only update never falls back to call id", () => {
    const { title, detail } = formatToolCardTitle({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-ba1b17dc-202a-4ed7-bd88-e0bfe9cd69af-4",
      status: "completed",
    });
    expect(title).toBe("Tool call · completed");
    expect(title).not.toContain("call-ba1b17dc");
    expect(detail).toBeUndefined();
  });

  it("merge keeps friendly base and applies latest status", () => {
    const merged = mergeToolTitles(
      "Read `…/imagine/SKILL.md`",
      "Tool call · completed",
    );
    expect(merged).toBe("Read `…/imagine/SKILL.md` · completed");
  });

  it("merge upgrades wire name to human title", () => {
    const merged = mergeToolTitles(
      "read_file · …/SKILL.md",
      "Read `C:\\Users\\Administrator\\.grok\\skills\\imagine\\SKILL.md`",
    );
    expect(toolTitleBaseQuality(splitToolTitle(merged).base)).toBeGreaterThan(
      toolTitleBaseQuality("read_file · …/SKILL.md"),
    );
    expect(merged).toContain("Read `");
  });

  it("describeUpdate never titles with call id", () => {
    const desc = describeUpdate({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-ba1b17dc-202a-4ed7-bd88-e0bfe9cd69af-4",
          status: "completed",
        },
      },
    });
    expect(desc.kind).toBe("tool");
    expect(desc.title).toBe("Tool call · completed");
    expect(desc.toolCallId).toBe(
      "call-ba1b17dc-202a-4ed7-bd88-e0bfe9cd69af-4",
    );
    expect(desc.detail).toBeUndefined();
  });

  it("describeUpdate uses ACP Read path title", () => {
    const desc = describeUpdate({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-f8b05138-361f-4d22-96a9-d3d94930cd93-0",
          title: "Read `src/utils/format.ts`",
          status: "completed",
        },
      },
    });
    expect(desc.title).toBe("Read `src/utils/format.ts` · completed");
  });
});

import { describe, expect, it } from "vitest";
import { describeUpdate } from "./format";
import {
  formatToolCardParts,
  isToolCallId,
  mergeToolCardParts,
} from "./toolTitle";

describe("friendly tool titles", () => {
  it("detects call ids", () => {
    expect(isToolCallId("call-ba1b17dc-202a-4ed7-bd88-e0bfe9cd69af-4")).toBe(
      true,
    );
    expect(isToolCallId("Read `attribution.py`")).toBe(false);
  });

  it("formats initial tool_call with label + path", () => {
    const parts = formatToolCardParts({
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
    expect(parts.baseTitle).toBe("Read `…/imagine/SKILL.md`");
    expect(parts.title).toBe("Read `…/imagine/SKILL.md`");
    expect(parts.title).not.toMatch(/^call-/);
    expect(parts.detail).toBeUndefined();
  });

  it("keeps ACP human title on tool_call_update", () => {
    const parts = formatToolCardParts({
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
    expect(parts.baseTitle).toContain("Read `");
    expect(parts.baseTitle).toContain("SKILL.md");
    expect(isToolCallId(parts.baseTitle)).toBe(false);
  });

  it("status-only update never falls back to call id", () => {
    const parts = formatToolCardParts({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-ba1b17dc-202a-4ed7-bd88-e0bfe9cd69af-4",
      status: "completed",
    });
    expect(parts.baseTitle).toBe("Tool call");
    expect(parts.status).toBe("completed");
    expect(parts.title).toBe("Tool call ☑️");
    expect(parts.title).not.toContain("call-ba1b17dc");
  });

  it("merge keeps friendly base and applies latest status", () => {
    const merged = mergeToolCardParts(
      {
        baseTitle: "Read `…/imagine/SKILL.md`",
        title: "Read `…/imagine/SKILL.md`",
      },
      {
        baseTitle: "Tool call",
        status: "completed",
        title: "Tool call ☑️",
      },
    );
    expect(merged.baseTitle).toBe("Read `…/imagine/SKILL.md`");
    expect(merged.status).toBe("completed");
    expect(merged.title).toBe("Read `…/imagine/SKILL.md` ☑️");
  });

  it("merge upgrades wire name to human title", () => {
    const merged = mergeToolCardParts(
      {
        baseTitle: "read_file · …/SKILL.md",
        title: "read_file · …/SKILL.md",
      },
      {
        baseTitle:
          "Read `C:\\Users\\Administrator\\.grok\\skills\\imagine\\SKILL.md`",
        title:
          "Read `C:\\Users\\Administrator\\.grok\\skills\\imagine\\SKILL.md`",
      },
    );
    expect(merged.baseTitle).toContain("Read `");
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
    expect(desc.title).toBe("Tool call ☑️");
    expect(desc.toolBase).toBe("Tool call");
    expect(desc.toolStatus).toBe("completed");
    expect(desc.toolCallId).toBe(
      "call-ba1b17dc-202a-4ed7-bd88-e0bfe9cd69af-4",
    );
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
    expect(desc.toolBase).toBe("Read `src/utils/format.ts`");
    expect(desc.toolStatus).toBe("completed");
    expect(desc.title).toBe("Read `src/utils/format.ts` ☑️");
  });
});

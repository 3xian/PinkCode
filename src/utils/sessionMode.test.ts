import { describe, expect, it } from "vitest";
import {
  applyAgentModeUpdate,
  applySessionModeChange,
  applySessionModeToPrompt,
  cycleSessionMode,
  displaySessionMode,
  sessionModeFromPermission,
} from "./sessionMode";

describe("cycleSessionMode", () => {
  it("cycles Normal → Plan → Ask → Auto → Always-approve → Normal", () => {
    expect(cycleSessionMode("normal")).toBe("plan");
    expect(cycleSessionMode("plan")).toBe("ask");
    expect(cycleSessionMode("ask")).toBe("auto");
    expect(cycleSessionMode("auto")).toBe("alwaysApprove");
    expect(cycleSessionMode("alwaysApprove")).toBe("normal");
  });
});

describe("applySessionModeToPrompt", () => {
  it("prefixes free text in plan and ask modes", () => {
    expect(applySessionModeToPrompt("plan", "add auth")).toBe("/plan add auth");
    expect(applySessionModeToPrompt("ask", "what is rust")).toBe("/ask what is rust");
  });

  it("leaves slash commands and non-plan/ask modes alone", () => {
    expect(applySessionModeToPrompt("plan", "/compact")).toBe("/compact");
    expect(applySessionModeToPrompt("ask", "/help")).toBe("/help");
    expect(applySessionModeToPrompt("normal", "add auth")).toBe("add auth");
    expect(applySessionModeToPrompt("auto", "add auth")).toBe("add auth");
  });
});

describe("applyAgentModeUpdate", () => {
  it("arms Plan when the agent enters plan mode", () => {
    expect(applyAgentModeUpdate("plan", false)).toEqual({
      planActive: true,
      planArmed: true,
    });
    expect(applyAgentModeUpdate("plan", true)).toEqual({
      planActive: true,
      planArmed: true,
    });
  });

  it("clears arming only when leaving an active agent plan", () => {
    expect(applyAgentModeUpdate("default", true)).toEqual({
      planActive: false,
      planArmed: false,
    });
  });

  it("preserves user Pending when agent still reports non-plan", () => {
    // User selected Mode=Plan (Pending); agent has not activated yet.
    expect(applyAgentModeUpdate("default", false)).toEqual({
      planActive: false,
      planArmed: null,
    });
    expect(applyAgentModeUpdate("code", false)).toEqual({
      planActive: false,
      planArmed: null,
    });
  });
});

describe("planArmed + permission model", () => {
  it("displays Plan only when armed", () => {
    expect(displaySessionMode(true, "default")).toBe("plan");
    expect(displaySessionMode(true, "bypassPermissions")).toBe("plan");
    expect(displaySessionMode(false, "auto")).toBe("auto");
    expect(displaySessionMode(false, "bypassPermissions")).toBe(
      "alwaysApprove",
    );
    expect(displaySessionMode(false, "acceptEdits")).toBe("normal");
  });

  it("applies Mode to planArmed and optional permission write", () => {
    expect(applySessionModeChange("plan", "default")).toEqual({
      planArmed: true,
      permission: null,
    });
    expect(applySessionModeChange("plan", "auto")).toEqual({
      planArmed: true,
      permission: null,
    });
    expect(applySessionModeChange("ask", "default")).toEqual({
      planArmed: false,
      permission: null,
    });
    expect(applySessionModeChange("ask", "auto")).toEqual({
      planArmed: false,
      permission: null,
    });
    expect(applySessionModeChange("auto", "default")).toEqual({
      planArmed: false,
      permission: "auto",
    });
    expect(applySessionModeChange("alwaysApprove", "auto")).toEqual({
      planArmed: false,
      permission: "bypassPermissions",
    });
  });

  it("Normal only resets Auto / Always-approve, preserves fine-grained", () => {
    expect(applySessionModeChange("normal", "auto")).toEqual({
      planArmed: false,
      permission: "default",
    });
    expect(applySessionModeChange("normal", "bypassPermissions")).toEqual({
      planArmed: false,
      permission: "default",
    });
    expect(applySessionModeChange("normal", "acceptEdits")).toEqual({
      planArmed: false,
      permission: null,
    });
    expect(applySessionModeChange("normal", "dontAsk")).toEqual({
      planArmed: false,
      permission: null,
    });
    expect(applySessionModeChange("normal", "default")).toEqual({
      planArmed: false,
      permission: null,
    });
  });

  it("maps permission modes to non-Plan session modes", () => {
    expect(sessionModeFromPermission("auto")).toBe("auto");
    expect(sessionModeFromPermission("bypassPermissions")).toBe(
      "alwaysApprove",
    );
    expect(sessionModeFromPermission("acceptEdits")).toBe("normal");
    expect(sessionModeFromPermission("dontAsk")).toBe("normal");
  });
});



import { describe, expect, it } from "vitest";
import {
  agentSlashForPermissionTransition,
  applySessionModeChange,
  applySessionModeToPrompt,
  canSendModeSlash,
  cycleSessionMode,
  displaySessionMode,
  permissionRing,
  sessionModeFromPermission,
} from "./sessionMode";

describe("cycleSessionMode", () => {
  it("cycles Normal → Plan → Auto → Always-approve → Normal", () => {
    expect(cycleSessionMode("normal")).toBe("plan");
    expect(cycleSessionMode("plan")).toBe("auto");
    expect(cycleSessionMode("auto")).toBe("alwaysApprove");
    expect(cycleSessionMode("alwaysApprove")).toBe("normal");
  });
});

describe("applySessionModeToPrompt", () => {
  it("prefixes free text in plan mode", () => {
    expect(applySessionModeToPrompt("plan", "add auth")).toBe("/plan add auth");
  });

  it("leaves slash commands and non-plan modes alone", () => {
    expect(applySessionModeToPrompt("plan", "/compact")).toBe("/compact");
    expect(applySessionModeToPrompt("normal", "add auth")).toBe("add auth");
    expect(applySessionModeToPrompt("auto", "add auth")).toBe("add auth");
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

describe("agentSlashForPermissionTransition", () => {
  it("maps ring transitions to Grok toggle slashes", () => {
    expect(agentSlashForPermissionTransition("default", "auto")).toBe("/auto");
    expect(
      agentSlashForPermissionTransition("default", "bypassPermissions"),
    ).toBe("/always-approve");
    expect(agentSlashForPermissionTransition("auto", "bypassPermissions")).toBe(
      "/always-approve",
    );
    expect(agentSlashForPermissionTransition("bypassPermissions", "auto")).toBe(
      "/auto",
    );
    expect(agentSlashForPermissionTransition("auto", "default")).toBe("/auto");
    expect(
      agentSlashForPermissionTransition("bypassPermissions", "default"),
    ).toBe("/always-approve");
  });

  it("skips no-ops and fine-grained-only moves", () => {
    expect(agentSlashForPermissionTransition("default", "acceptEdits")).toBe(
      null,
    );
    expect(agentSlashForPermissionTransition("acceptEdits", "dontAsk")).toBe(
      null,
    );
    expect(agentSlashForPermissionTransition("auto", "auto")).toBe(null);
  });
});

describe("permissionRing + canSendModeSlash", () => {
  it("collapses fine-grained to ask", () => {
    expect(permissionRing("default")).toBe("ask");
    expect(permissionRing("acceptEdits")).toBe("ask");
    expect(permissionRing("dontAsk")).toBe("ask");
    expect(permissionRing("auto")).toBe("auto");
    expect(permissionRing("bypassPermissions")).toBe("yolo");
  });

  it("treats ready as the only idle status for mode-related gates", () => {
    expect(canSendModeSlash("ready")).toBe(true);
    expect(canSendModeSlash("running")).toBe(false);
    expect(canSendModeSlash("awaitingPermission")).toBe(false);
    expect(canSendModeSlash("stopped")).toBe(false);
    expect(canSendModeSlash(null)).toBe(false);
  });
});

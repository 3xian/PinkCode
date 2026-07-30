import { describe, expect, it, vi } from "vitest";
import {
  runWindowCommand,
  windowsUpdateStatusLabel,
} from "./windowsTitlebar";

describe("windowsUpdateStatusLabel", () => {
  it("maps every manual update state to persistent status text", () => {
    expect(windowsUpdateStatusLabel("idle")).toBeNull();
    expect(windowsUpdateStatusLabel("checking")).toBe(
      "Checking for updates…",
    );
    expect(windowsUpdateStatusLabel("up-to-date")).toBe("You're up to date");
    expect(windowsUpdateStatusLabel("error")).toBe("Update check failed");
  });
});

describe("runWindowCommand", () => {
  it("does not report successful commands", async () => {
    const onError = vi.fn();
    await runWindowCommand("minimize", async () => undefined, onError);
    expect(onError).not.toHaveBeenCalled();
  });

  it("turns rejected native commands into actionable UI errors", async () => {
    const onError = vi.fn();
    await runWindowCommand(
      "close",
      async () => {
        throw new Error("permission denied");
      },
      onError,
    );
    expect(onError).toHaveBeenCalledWith(
      "Failed to close window: permission denied",
    );
  });
});

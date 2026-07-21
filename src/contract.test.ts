import { describe, expect, it } from "vitest";
import contract from "../contracts/agent-contract.json";
import {
  MANAGED_STATUSES,
  PERMISSION_KINDS,
  PERMISSION_MODES,
} from "./types";

describe("frontend agent contract", () => {
  it("matches the shared serialized enum values", () => {
    expect([...MANAGED_STATUSES]).toEqual(contract.managedStatuses);
    expect([...PERMISSION_MODES]).toEqual(contract.permissionModes);
    expect([...PERMISSION_KINDS]).toEqual(contract.permissionKinds);
  });
});

import { describe, expect, it } from "vitest";
import {
  filterSlashCommands,
  mergeSlashCommands,
  resolveSlashCommandCatalog,
  SLASH_MENU_LIMIT,
} from "./slashCommands";
import type { AvailableCommand } from "../types";

describe("filterSlashCommands", () => {
  const catalog: AvailableCommand[] = [
    { name: "compact", description: "Compress conversation history" },
    { name: "context", description: "Show context window usage" },
    { name: "copy", description: "Copy recent response" },
    {
      name: "code-review",
      description: "Run an extremely strict maintainability review",
    },
    { name: "create-skill", description: "Scaffold a new skill" },
    { name: "help", description: "List local commands" },
  ];

  it("returns a capped catalog when the query is empty", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      name: `cmd-${i}`,
      description: `Command ${i}`,
    }));
    expect(filterSlashCommands(many, "").length).toBe(SLASH_MENU_LIMIT);
  });

  it("ranks name prefix matches first (skills like code-review)", () => {
    const hits = filterSlashCommands(catalog, "code");
    // "code-review" is the only name containing "code" in this catalog.
    expect(hits.map((c) => c.name)).toEqual(["code-review"]);
    // Prefix ranks above a description-only hit for the same token.
    const withDesc: AvailableCommand[] = [
      {
        name: "docs",
        description: "Browse code style guides",
      },
      {
        name: "code-review",
        description: "Strict review",
      },
    ];
    expect(filterSlashCommands(withDesc, "code").map((c) => c.name)).toEqual([
      "code-review",
      "docs",
    ]);
  });

  it("prefers name substring over description-only hits", () => {
    const hits = filterSlashCommands(catalog, "review");
    expect(hits[0]?.name).toBe("code-review");
  });

  it("matches description when the name does not", () => {
    const hits = filterSlashCommands(catalog, "maintainability");
    expect(hits.map((c) => c.name)).toEqual(["code-review"]);
  });
});

describe("mergeSlashCommands", () => {
  it("keeps agent skills and fills missing builtins", () => {
    const agent: AvailableCommand[] = [
      { name: "compact", description: "from agent" },
      { name: "code-review", description: "skill" },
    ];
    const merged = mergeSlashCommands(agent);
    expect(merged.find((c) => c.name === "compact")?.description).toBe(
      "from agent",
    );
    expect(merged.some((c) => c.name === "code-review")).toBe(true);
    expect(merged.some((c) => c.name === "usage")).toBe(true);
  });
});

describe("resolveSlashCommandCatalog", () => {
  const builtins: AvailableCommand[] = [
    { name: "help", description: "Builtin help" },
    { name: "usage", description: "Builtin usage" },
  ];
  const inspected: AvailableCommand[] = [
    { name: "help", description: "Colliding skill" },
    { name: "code-review", description: "Review skill" },
  ];

  it("uses inspected skills only as a pre-attach fallback", () => {
    const resolved = resolveSlashCommandCatalog(null, inspected, builtins);
    expect(resolved.map((command) => command.name)).toEqual([
      "help",
      "usage",
      "code-review",
    ]);
    expect(resolved[0]?.description).toBe("Builtin help");
  });

  it("does not resurrect inspected skills omitted by ACP", () => {
    const agent = [{ name: "usage", description: "Agent usage" }];
    const resolved = resolveSlashCommandCatalog(agent, inspected, builtins);
    expect(resolved.map((command) => command.name)).toEqual(["usage", "help"]);
    expect(resolved.some((command) => command.name === "code-review")).toBe(
      false,
    );
  });

  it("treats an empty ACP catalog as authoritative", () => {
    const resolved = resolveSlashCommandCatalog([], inspected, builtins);
    expect(resolved).toEqual(builtins);
  });
});

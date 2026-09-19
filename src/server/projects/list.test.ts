import { describe, expect, it } from "vitest";
import { createBrowserProjectForOwner } from "./store";
import { invalidateProjectsForOwner, listProjectsForOwner } from "./list";

describe("project picker list", () => {
  it("returns picker-ready projects with a null thumbnail fallback in memory mode", async () => {
    const ownerId = `picker-owner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const project = await createBrowserProjectForOwner(ownerId, { name: "Neon Test" });

    const result = await listProjectsForOwner(ownerId);

    expect(result.nextCursor).toBeNull();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: project.id,
      title: "Neon Test",
      slug: "neon-test",
      thumbnailUrl: null,
    });
  });

  it("busts the per-owner cache when invalidated", async () => {
    const ownerId = `picker-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await createBrowserProjectForOwner(ownerId, { name: "First" });

    const first = await listProjectsForOwner(ownerId);
    await createBrowserProjectForOwner(ownerId, { name: "Second" });
    const cached = await listProjectsForOwner(ownerId);
    invalidateProjectsForOwner(ownerId);
    const refreshed = await listProjectsForOwner(ownerId);

    expect(first.items.map((item) => item.title)).toEqual(["First"]);
    expect(cached.items.map((item) => item.title)).toEqual(["First"]);
    expect(refreshed.items.map((item) => item.title)).toContain("Second");
  });
});

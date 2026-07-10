import { describe, expect, test } from "bun:test"
import { createEmptyState } from "./events"
import { getCodexThreadSyncProjects } from "./server"

describe("Codex thread synchronization targets", () => {
  test("includes only active projects that the user has saved", () => {
    const state = createEmptyState()
    state.projectsById.set("saved", {
      id: "saved",
      localPath: "/tmp/saved",
      title: "Saved",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectsById.set("removed", {
      id: "removed",
      localPath: "/tmp/removed",
      title: "Removed",
      createdAt: 1,
      updatedAt: 2,
      deletedAt: 3,
    })

    expect(getCodexThreadSyncProjects(state)).toEqual([
      { id: "saved", localPath: "/tmp/saved" },
    ])
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { WorktreeManager } from "./worktree-manager"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function runGit(cwd: string, args: string[]) {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

describe("WorktreeManager", () => {
  test("creates, persists, and safely removes a clean managed worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-worktree-test-"))
    tempDirs.push(root)
    const repo = path.join(root, "repo")
    const store = new EventStore(path.join(root, "data"))
    await Bun.write(path.join(root, ".keep"), "")
    await runGit(root, ["init", repo])
    await runGit(repo, ["config", "user.email", "kanna@example.test"])
    await runGit(repo, ["config", "user.name", "Kanna Test"])
    await writeFile(path.join(repo, "README.md"), "hello\n", "utf8")
    await runGit(repo, ["add", "README.md"])
    await runGit(repo, ["commit", "-m", "Initial"])

    await store.initialize()
    const project = await store.openProject(repo, "Repo")
    const manager = new WorktreeManager(store, path.join(root, "worktrees"))
    const created = await manager.createForProject(project, "Implement review", "codex/review-test")

    expect(created.worktree).toMatchObject({
      baseProjectId: project.id,
      basePath: repo,
      branchName: "codex/review-test",
    })
    expect(await runGit(created.project.localPath, ["branch", "--show-current"])).toBe("codex/review-test")
    expect(store.getProject(created.project.id)?.worktree?.branchName).toBe("codex/review-test")

    const removed = await manager.remove(created.project)
    expect(removed.branchName).toBe("codex/review-test")
    expect(store.getProject(created.project.id)).toBeNull()
    expect((await runGit(repo, ["branch", "--list", "codex/review-test"]))).toContain("codex/review-test")
  })
})

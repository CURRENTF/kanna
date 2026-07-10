import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { WorktreeInfo } from "../shared/types"
import type { EventStore } from "./event-store"
import type { ProjectRecord } from "./events"

async function runGit(cwd: string, args: string[]) {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

function gitError(result: Awaited<ReturnType<typeof runGit>>, fallback: string) {
  return new Error(result.stderr || result.stdout || fallback)
}

function branchSlug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "task"
}

export class WorktreeManager {
  constructor(
    private readonly store: EventStore,
    private readonly worktreesRoot = path.join(store.dataDir, "worktrees"),
  ) {}

  async createForProject(sourceProject: ProjectRecord, title: string, requestedBranchName?: string) {
    const repoResult = await runGit(sourceProject.localPath, ["rev-parse", "--show-toplevel"])
    if (repoResult.exitCode !== 0 || !repoResult.stdout) {
      throw gitError(repoResult, "This project is not a Git repository")
    }

    const baseProject = sourceProject.worktree
      ? this.store.getProject(sourceProject.worktree.baseProjectId)
        ?? await this.store.openProject(sourceProject.worktree.basePath)
      : sourceProject
    const repoRoot = sourceProject.worktree?.repoRoot ?? repoResult.stdout
    const suffix = randomUUID().slice(0, 8)
    const branchName = requestedBranchName?.trim() || `codex/${branchSlug(title)}-${suffix}`
    const validation = await runGit(repoRoot, ["check-ref-format", "--branch", branchName])
    if (validation.exitCode !== 0) {
      throw gitError(validation, `Invalid branch name: ${branchName}`)
    }

    const worktreePath = path.join(
      this.worktreesRoot,
      branchSlug(path.basename(repoRoot)),
      `${branchSlug(branchName)}-${suffix}`,
    )
    await mkdir(path.dirname(worktreePath), { recursive: true })

    const addResult = await runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, "HEAD"])
    if (addResult.exitCode !== 0) {
      throw gitError(addResult, "Git could not create the worktree")
    }

    const worktree: WorktreeInfo = {
      baseProjectId: baseProject.id,
      basePath: baseProject.localPath,
      repoRoot,
      branchName,
    }

    try {
      const project = await this.store.openProject(
        worktreePath,
        `${baseProject.title} · ${branchName}`,
        worktree,
      )
      return { project, worktree }
    } catch (error) {
      await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath])
      await runGit(repoRoot, ["branch", "-D", branchName])
      throw error
    }
  }

  async remove(project: ProjectRecord, options: { force?: boolean } = {}) {
    if (!project.worktree) {
      throw new Error("Project is not a managed worktree")
    }

    const status = await runGit(project.localPath, ["status", "--porcelain"])
    if (status.exitCode === 0 && status.stdout && !options.force) {
      throw new Error("Worktree has uncommitted changes; commit or discard them before removal")
    }

    const args = ["worktree", "remove"]
    if (options.force) args.push("--force")
    args.push(project.localPath)
    const result = await runGit(project.worktree.repoRoot, args)
    if (result.exitCode !== 0) {
      throw gitError(result, "Git could not remove the worktree")
    }

    await this.store.removeProject(project.id)
    return {
      baseProjectId: project.worktree.baseProjectId,
      branchName: project.worktree.branchName,
    }
  }
}

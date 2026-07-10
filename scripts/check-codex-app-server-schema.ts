import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const binary = process.env.KANNA_CODEX_BINARY?.trim() || "codex"
const outputDir = await mkdtemp(path.join(tmpdir(), "kanna-codex-schema-"))

const requiredClientMethods = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/list",
  "thread/read",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/delete",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "review/start",
  "model/list",
  "config/read",
  "config/value/write",
  "skills/list",
  "skills/config/write",
  "hooks/list",
  "plugin/list",
  "plugin/install",
  "plugin/uninstall",
  "marketplace/add",
  "marketplace/remove",
  "marketplace/upgrade",
  "mcpServerStatus/list",
  "mcpServer/oauth/login",
]

const requiredNotifications = [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "turn/diff/updated",
  "turn/completed",
]

try {
  const process = Bun.spawn([binary, "app-server", "generate-ts", "--experimental", "--out", outputDir], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `schema generation exited with ${exitCode}`)
  }

  const [clientRequests, notifications] = await Promise.all([
    readFile(path.join(outputDir, "ClientRequest.ts"), "utf8"),
    readFile(path.join(outputDir, "ServerNotification.ts"), "utf8"),
  ])
  const missing = [
    ...requiredClientMethods.filter((method) => !clientRequests.includes(`"method": "${method}"`)),
    ...requiredNotifications.filter((method) => !notifications.includes(`"method": "${method}"`)),
  ]
  if (missing.length > 0) {
    throw new Error(`Codex app-server protocol is missing required methods: ${missing.join(", ")}`)
  }

  const versionProcess = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
  const version = (await new Response(versionProcess.stdout).text()).trim()
  await versionProcess.exited
  console.log(`[kanna] Codex app-server schema compatible${version ? ` (${version})` : ""}`)
} finally {
  await rm(outputDir, { recursive: true, force: true })
}

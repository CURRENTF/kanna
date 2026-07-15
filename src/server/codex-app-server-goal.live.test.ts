import { describe, expect, test } from "bun:test"
import { CodexAppServerManager } from "./codex-app-server"

const shouldRunLiveGoalTests = process.env.KANNA_RUN_LIVE_GOAL_TESTS === "1"

async function collectAssistantText(stream: AsyncIterable<any>) {
  const text: string[] = []
  for await (const event of stream) {
    if (event.type === "transcript" && event.entry?.kind === "assistant_text") {
      text.push(event.entry.text)
    }
  }
  return text.join("\n")
}

if (shouldRunLiveGoalTests) {
  describe("live Codex goal slash commands", () => {
    test("sets and clears a goal through a real app-server session", async () => {
      const manager = new CodexAppServerManager()
      const chatId = `live-goal-${Date.now()}`

      try {
        await manager.startSession({
          chatId,
          cwd: process.cwd(),
          model: "gpt-5.5",
          sessionToken: null,
        })

        const objective = `kanna live goal clear e2e ${Date.now()}`
        const setTurn = await manager.startTurn({
          chatId,
          model: "gpt-5.5",
          content: `/goal ${objective}`,
          planMode: false,
          onToolRequest: async () => ({}),
        })
        expect(await collectAssistantText(setTurn.stream)).toContain(`Goal set: ${objective}`)

        const getBeforeClearTurn = await manager.startTurn({
          chatId,
          model: "gpt-5.5",
          content: "/goal",
          planMode: false,
          onToolRequest: async () => ({}),
        })
        expect(await collectAssistantText(getBeforeClearTurn.stream)).toContain(`Goal: ${objective}`)

        const clearTurn = await manager.startTurn({
          chatId,
          model: "gpt-5.5",
          content: "/goal clear",
          planMode: false,
          onToolRequest: async () => ({}),
        })
        expect(await collectAssistantText(clearTurn.stream)).toContain("Goal cleared.")

        const getAfterClearTurn = await manager.startTurn({
          chatId,
          model: "gpt-5.5",
          content: "/goal",
          planMode: false,
          onToolRequest: async () => ({}),
        })
        expect(await collectAssistantText(getAfterClearTurn.stream)).toContain("No active goal.")
      } finally {
        manager.stopAll()
      }
    }, 20_000)
  })
}

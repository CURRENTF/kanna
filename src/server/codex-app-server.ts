import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type {
  AskUserQuestionItem,
  ChatAttachment,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexReviewTarget,
  CodexSandboxMode,
  ContextWindowUsageSnapshot,
  ServiceTier,
  TodoItem,
  TranscriptEntry,
} from "../shared/types"
import type { HarnessEvent, HarnessToolRequest, HarnessTurn } from "./harness-types"
import {
  type CollabAgentToolCallItem,
  type CommandExecutionOutputDeltaNotification,
  type AgentMessageDeltaNotification,
  type ContextCompactedNotification,
  type ConfigReadResponse,
  type CodexRequestId,
  type CommandExecutionApprovalDecision,
  type CommandExecutionRequestApprovalParams,
  type CommandExecutionRequestApprovalResponse,
  type DynamicToolCallOutputContentItem,
  type DynamicToolCallResponse,
  type FileChangeApprovalDecision,
  type FileChangeItem,
  type FileChangePatchUpdatedNotification,
  type FileChangeRequestApprovalParams,
  type FileChangeRequestApprovalResponse,
  type InitializeParams,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type JsonRpcResponse,
  type HooksListResponse,
  type McpToolCallItem,
  type McpToolCallProgressNotification,
  type McpServerStatusListResponse,
  type PlanDeltaNotification,
  type PluginListResponse,
  type RawResponseItemCompletedNotification,
  type ReviewStartParams,
  type ReviewStartResponse,
  type SandboxPolicy,
  type ReasoningSummaryTextDeltaNotification,
  type ServerNotification,
  type ServerRequest,
  type SkillsListResponse,
  type ThreadGoalClearParams,
  type ThreadGoalClearResponse,
  type ThreadGoalGetParams,
  type ThreadGoalGetResponse,
  type ThreadGoalSetParams,
  type ThreadGoalSetResponse,
  type CodexThreadRecord,
  type ThreadArchiveParams,
  type ThreadDeleteParams,
  type ThreadListParams,
  type ThreadListResponse,
  type ThreadReadParams,
  type ThreadReadResponse,
  type ThreadSetNameParams,
  type CodexModelRecord,
  type ModelListResponse,
  type ThreadItem,
  type ThreadResumeParams,
  type ThreadResumeResponse,
  type ThreadForkParams,
  type ThreadForkResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ThreadTokenUsageUpdatedNotification,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputQuestion,
  type ToolRequestUserInputResponse,
  type TurnPlanStep,
  type TurnPlanUpdatedNotification,
  type TurnCompletedNotification,
  type TurnInterruptParams,
  type TurnDiffUpdatedNotification,
  type TurnStartParams,
  type TurnStartResponse,
  type CodexUserInput,
  type TurnSteerParams,
  type TurnSteerResponse,
  isJsonRpcResponse,
  isServerNotification,
  isServerRequest,
} from "./codex-app-server-protocol"

interface CodexAppServerProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed?: boolean
  kill(signal?: NodeJS.Signals | number): void
  on(event: "close", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
  once(event: "close", listener: (code: number | null) => void): this
  once(event: "error", listener: (error: Error) => void): this
}

type SpawnCodexAppServer = (cwd: string) => CodexAppServerProcess

interface PendingRequest<TResult> {
  method: string
  resolve: (value: TResult) => void
  reject: (error: Error) => void
}

interface ConnectionContext {
  child: CodexAppServerProcess
  pendingRequests: Map<CodexRequestId, PendingRequest<unknown>>
  stderrLines: string[]
  closed: boolean
}

interface PendingTurn {
  turnId: string | null
  model: string
  planMode: boolean
  queue: AsyncQueue<HarnessEvent>
  startedToolIds: Set<string>
  handledDynamicToolIds: Set<string>
  latestPlanExplanation: string | null
  latestPlanSteps: TurnPlanStep[]
  latestPlanText: string | null
  planTextByItemId: Map<string, string>
  commandOutputByItemId: Map<string, string>
  todoSequence: number
  pendingWebSearchResultToolId: string | null
  resolved: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onApprovalRequest?: (
    request:
      | {
          requestId: CodexRequestId
          kind: "command_execution"
          params: CommandExecutionRequestApprovalParams
        }
      | {
          requestId: CodexRequestId
          kind: "file_change"
          params: FileChangeRequestApprovalParams
        }
  ) => Promise<CommandExecutionApprovalDecision | FileChangeApprovalDecision>
}

interface SessionContext {
  chatId: string
  cwd: string
  connection: ConnectionContext
  pendingTurn: PendingTurn | null
  sessionToken: string | null
  model: string
  serviceTier?: ServiceTier
  approvalPolicy: CodexApprovalPolicy
  sandboxMode: CodexSandboxMode
  closed: boolean
}

type GoalSlashCommand =
  | { kind: "get" }
  | { kind: "clear" }
  | { kind: "set"; objective: string }

export interface StartCodexSessionArgs {
  chatId: string
  cwd: string
  model: string
  serviceTier?: ServiceTier
  sessionToken: string | null
  pendingForkSessionToken?: string | null
  approvalPolicy?: CodexApprovalPolicy
  sandboxMode?: CodexSandboxMode
}

export interface StartCodexTurnArgs {
  chatId: string
  model: string
  effort?: CodexReasoningEffort
  serviceTier?: ServiceTier
  content: string
  attachments?: ChatAttachment[]
  planMode: boolean
  approvalPolicy?: CodexApprovalPolicy
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onApprovalRequest?: PendingTurn["onApprovalRequest"]
}

export interface StartCodexReviewArgs {
  chatId: string
  model: string
  target: CodexReviewTarget
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onApprovalRequest?: PendingTurn["onApprovalRequest"]
}

function codexTurnInput(content: string, attachments: ChatAttachment[] = []): CodexUserInput[] {
  const input: CodexUserInput[] = []
  const text = content.trim()
  if (text) {
    input.push({ type: "text", text, text_elements: [] })
  }
  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      input.push({ type: "localImage", path: attachment.absolutePath, detail: "auto" })
    } else {
      input.push({ type: "mention", name: attachment.displayName, path: attachment.absolutePath })
    }
  }
  if (input.length === 0) {
    input.push({ type: "text", text: "Please inspect the attached context.", text_elements: [] })
  }
  return input
}

function codexSandboxPolicy(mode: CodexSandboxMode, cwd: string): SandboxPolicy {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" }
  }
  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: false }
  }
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

export interface GenerateStructuredArgs {
  cwd: string
  prompt: string
  model?: string
  effort?: CodexReasoningEffort
  serviceTier?: ServiceTier
}

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now()
): TranscriptEntry {
  return {
    _id: randomUUID(),
    createdAt,
    ...entry,
  } as TranscriptEntry
}

function codexSystemInitEntry(model: string): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: "codex",
    model,
    tools: ["Bash", "Write", "Edit", "WebSearch", "TodoWrite", "AskUserQuestion", "ExitPlanMode"],
    agents: ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"],
    slashCommands: [],
    mcpServers: [],
  })
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function isRecoverableResumeError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  if (!message.includes("thread/resume")) return false
  return ["not found", "missing thread", "no such thread", "unknown thread", "does not exist"].some((snippet) =>
    message.includes(snippet)
  )
}

const MULTI_SELECT_HINT_PATTERN = /\b(all that apply|select all|choose all|pick all|select multiple|choose multiple|pick multiple|multiple selections?|multiple choice|more than one|one or more)\b/i

function inferQuestionAllowsMultiple(question: ToolRequestUserInputQuestion): boolean {
  const combinedText = [question.header, question.question].filter(Boolean).join(" ")
  return MULTI_SELECT_HINT_PATTERN.test(combinedText)
}

function toAskUserQuestionItems(params: ToolRequestUserInputParams): AskUserQuestionItem[] {
  return params.questions.map((question) => ({
    id: question.id,
    question: question.question,
    header: question.header || undefined,
    options: question.options?.map((option) => ({
      label: option.label,
      description: option.description ?? undefined,
    })),
    multiSelect: inferQuestionAllowsMultiple(question),
  }))
}

function toToolRequestUserInputResponse(raw: unknown, questions: ToolRequestUserInputParams["questions"]): ToolRequestUserInputResponse {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const answersValue = record.answers
  const value = answersValue && typeof answersValue === "object" && !Array.isArray(answersValue)
    ? answersValue as Record<string, unknown>
    : record
  const answers = Object.fromEntries(
    questions.map((question) => {
      const rawAnswer = value[question.id] ?? value[question.question]
      if (Array.isArray(rawAnswer)) {
        return [question.id, { answers: rawAnswer.map((entry) => String(entry)) }]
      }
      if (typeof rawAnswer === "string") {
        return [question.id, { answers: [rawAnswer] }]
      }
      if (rawAnswer && typeof rawAnswer === "object" && Array.isArray((rawAnswer as { answers?: unknown }).answers)) {
        return [question.id, { answers: ((rawAnswer as { answers: unknown[] }).answers).map((entry) => String(entry)) }]
      }
      return [question.id, { answers: [] }]
    })
  )
  return { answers }
}

function approvalAnswer(raw: unknown): string {
  const record = asRecord(raw)
  const answers = asRecord(record?.answers)
  const value = answers?.approval
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string") ?? ""
  }
  return typeof value === "string" ? value : ""
}

function questionAnswerValue(raw: unknown, id: string): unknown {
  const record = asRecord(raw)
  const answers = asRecord(record?.answers)
  return answers?.[id] ?? record?.[id]
}

function questionAnswer(raw: unknown, id: string): string {
  const value = questionAnswerValue(raw, id)
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string") ?? ""
  }
  return typeof value === "string" ? value : ""
}

function parseElicitationValue(value: unknown, type?: string) {
  if (type === "array") {
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry)).filter(Boolean)
    }
    return typeof value === "string"
      ? value.split(",").map((entry) => entry.trim()).filter(Boolean)
      : []
  }
  const text = Array.isArray(value)
    ? value.find((entry): entry is string => typeof entry === "string") ?? ""
    : typeof value === "string"
      ? value
      : value == null
        ? ""
        : String(value)
  if (type === "boolean") return text.toLowerCase() === "true"
  if (type === "number" || type === "integer") {
    const parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : text
  }
  return text
}

function approvalQuestionTool(
  toolId: string,
  question: string,
  reason?: string | null,
): HarnessToolRequest {
  return {
    tool: {
      kind: "tool",
      toolKind: "ask_user_question",
      toolName: "AskUserQuestion",
      toolId,
      input: {
        questions: [{
          id: "approval",
          header: "Approval",
          question,
          options: [
            { label: "Approve once", description: reason ?? "Allow this action once" },
            { label: "Approve for session", description: "Allow similar actions for the rest of this Codex session" },
            { label: "Decline", description: "Do not run this action" },
            { label: "Cancel turn", description: "Cancel the current Codex turn" },
          ],
          multiSelect: false,
        }],
      },
      rawInput: { question, reason },
    },
  }
}

function contentFromMcpResult(item: McpToolCallItem): unknown {
  if (item.error?.message) {
    return { error: item.error.message }
  }
  return item.result?.structuredContent ?? item.result?.content ?? null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizeCodexTokenUsage(
  notification: ThreadTokenUsageUpdatedNotification,
): ContextWindowUsageSnapshot | null {
  const usage = notification.tokenUsage
  const totalUsage = usage.total_token_usage ?? usage.total
  const lastUsage = usage.last_token_usage ?? usage.last

  const totalProcessedTokens = asNumber(totalUsage?.total_tokens) ?? asNumber(totalUsage?.totalTokens)
  const usedTokens = asNumber(lastUsage?.total_tokens) ?? asNumber(lastUsage?.totalTokens) ?? totalProcessedTokens
  if (usedTokens === undefined || usedTokens <= 0) {
    return null
  }

  const inputTokens = asNumber(lastUsage?.input_tokens) ?? asNumber(lastUsage?.inputTokens)
  const cachedInputTokens = asNumber(lastUsage?.cached_input_tokens) ?? asNumber(lastUsage?.cachedInputTokens)
  const outputTokens = asNumber(lastUsage?.output_tokens) ?? asNumber(lastUsage?.outputTokens)
  const reasoningOutputTokens =
    asNumber(lastUsage?.reasoning_output_tokens) ?? asNumber(lastUsage?.reasoningOutputTokens)
  const maxTokens = asNumber(usage.model_context_window) ?? asNumber(usage.modelContextWindow)

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { lastReasoningOutputTokens: reasoningOutputTokens } : {}),
    lastUsedTokens: usedTokens,
    compactsAutomatically: true,
  }
}

function todoStatus(status: TurnPlanStep["status"]): TodoItem["status"] {
  if (status === "completed") return "completed"
  if (status === "inProgress") return "in_progress"
  return "pending"
}

function planStepsToTodos(steps: TurnPlanStep[]): TodoItem[] {
  return steps.map((step) => ({
    content: step.step,
    status: todoStatus(step.status),
    activeForm: step.step,
  }))
}

function renderPlanMarkdownFromSteps(steps: TurnPlanStep[]): string {
  return steps.map((step) => {
    const checkbox = step.status === "completed" ? "[x]" : "[ ]"
    return `- ${checkbox} ${step.step}`
  }).join("\n")
}

function parseGoalSlashCommand(content: string): GoalSlashCommand | null {
  const trimmed = content.trim()
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(trimmed)
  if (!match) return null

  const arg = (match[1] ?? "").trim()
  if (!arg || arg.toLowerCase() === "status" || arg.toLowerCase() === "get") {
    return { kind: "get" }
  }
  if (arg.toLowerCase() === "clear" || arg.toLowerCase() === "reset" || arg.toLowerCase() === "remove") {
    return { kind: "clear" }
  }
  return { kind: "set", objective: arg }
}

function dynamicContentToText(contentItems: DynamicToolCallOutputContentItem[] | null | undefined): string {
  if (!contentItems?.length) return ""
  return contentItems
    .map((item) => item.type === "inputText" ? item.text ?? "" : item.imageUrl ?? "")
    .filter(Boolean)
    .join("\n")
}

function dynamicToolPayload(value: Record<string, unknown> | unknown[] | string | number | boolean | null | undefined): Record<string, unknown> {
  const record = asRecord(value)
  if (record) return record
  return { value }
}

function commandOutputFromRawFunctionCallOutput(output: string): string | null {
  const marker = "\nOutput:\n"
  const markerIndex = output.lastIndexOf(marker)
  if (markerIndex === -1) {
    return null
  }
  return output.slice(markerIndex + marker.length)
}

function webSearchQuery(item: Extract<ThreadItem, { type: "webSearch" }>): string {
  return item.query || item.action?.query || item.action?.queries?.find((query) => typeof query === "string") || ""
}

function genericDynamicToolCall(toolId: string, toolName: string, input: Record<string, unknown>): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "unknown_tool",
      toolName,
      toolId,
      input: {
        payload: input,
      },
      rawInput: input,
    },
  })
}

function collabToolCall(item: CollabAgentToolCallItem): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "subagent_task",
      toolName: "Task",
      toolId: item.id,
      input: {
        subagentType: item.tool,
        senderThreadId: item.senderThreadId,
        receiverThreadIds: item.receiverThreadIds,
        prompt: item.prompt ?? null,
        agentsStates: item.agentsStates ?? {},
      },
      rawInput: item as unknown as Record<string, unknown>,
    },
  })
}

function todoToolCall(toolId: string, steps: TurnPlanStep[]): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "todo_write",
      toolName: "TodoWrite",
      toolId,
      input: {
        todos: planStepsToTodos(steps),
      },
      rawInput: {
        plan: steps,
      },
    },
  })
}

function fileChangeKind(
  kind: "add" | "delete" | "update" | { type: "add" | "delete" | "update"; move_path?: string | null }
): { type: "add" | "delete" | "update"; movePath?: string | null } {
  if (typeof kind === "string") {
    return { type: kind }
  }
  return {
    type: kind.type,
    movePath: kind.move_path ?? null,
  }
}

function fileChangeToolId(itemId: string, index: number, totalChanges: number): string {
  if (totalChanges === 1) {
    return itemId
  }
  return `${itemId}:change:${index}`
}

function fileChangePayload(
  item: Extract<ThreadItem, { type: "fileChange" }>,
  change: Extract<ThreadItem, { type: "fileChange" }>["changes"][number]
): Record<string, unknown> {
  return {
    ...item,
    changes: [change],
  } as unknown as Record<string, unknown>
}

function parseUnifiedDiff(diff: string): { oldString: string; newString: string } {
  const oldLines: string[] = []
  const newLines: string[] = []

  for (const line of diff.split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue
    if (line === "\\ No newline at end of file") continue

    const prefix = line[0]
    const content = line.slice(1)

    if (prefix === " ") {
      oldLines.push(content)
      newLines.push(content)
      continue
    }
    if (prefix === "-") {
      oldLines.push(content)
      continue
    }
    if (prefix === "+") {
      newLines.push(content)
    }
  }

  return {
    oldString: oldLines.join("\n"),
    newString: newLines.join("\n"),
  }
}

function isUnifiedDiff(diff: string) {
  return diff.includes("@@")
    || diff.startsWith("---")
    || diff.startsWith("+++")
    || diff.split(/\r?\n/).some((line) => (
      line.startsWith("+")
      || line.startsWith("-")
      || line.startsWith(" ")
      || line === "\\ No newline at end of file"
    ))
}

function fileChangeToToolCalls(item: Extract<ThreadItem, { type: "fileChange" }>): TranscriptEntry[] {
  return item.changes.map((change, index) => {
    const payload = fileChangePayload(item, change)
    const toolId = fileChangeToolId(item.id, index, item.changes.length)
    const normalizedKind = fileChangeKind(change.kind)

    if (normalizedKind.movePath) {
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "unknown_tool",
          toolName: "FileChange",
          toolId,
          input: {
            payload,
          },
          rawInput: payload,
        },
      })
    }

    if (typeof change.diff === "string") {
      const diffIsUnified = isUnifiedDiff(change.diff)
      const { oldString, newString } = diffIsUnified
        ? parseUnifiedDiff(change.diff)
        : { oldString: change.diff, newString: change.diff }

      if (normalizedKind.type === "add") {
        return timestamped({
          kind: "tool_call",
          tool: {
            kind: "tool",
            toolKind: "write_file",
            toolName: "Write",
            toolId,
            input: {
              filePath: change.path,
              content: newString,
            },
            rawInput: payload,
          },
        })
      }

      if (normalizedKind.type === "update") {
        if (!diffIsUnified) {
          return timestamped({
            kind: "tool_call",
            tool: {
              kind: "tool",
              toolKind: "unknown_tool",
              toolName: "FileChange",
              toolId,
              input: {
                payload,
              },
              rawInput: payload,
            },
          })
        }

        return timestamped({
          kind: "tool_call",
          tool: {
            kind: "tool",
            toolKind: "edit_file",
            toolName: "Edit",
            toolId,
            input: {
              filePath: change.path,
              oldString,
              newString,
            },
            rawInput: payload,
          },
        })
      }

      if (normalizedKind.type === "delete") {
        return timestamped({
          kind: "tool_call",
          tool: {
            kind: "tool",
            toolKind: "delete_file",
            toolName: "Delete",
            toolId,
            input: {
              filePath: change.path,
              content: oldString,
            },
            rawInput: payload,
          },
        })
      }
    }

    return timestamped({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "unknown_tool",
        toolName: "FileChange",
        toolId,
        input: {
          payload,
        },
        rawInput: payload,
      },
    })
  })
}

function fileChangeToToolResults(item: Extract<ThreadItem, { type: "fileChange" }>): TranscriptEntry[] {
  return item.changes.map((change, index) => timestamped({
    kind: "tool_result",
    toolId: fileChangeToolId(item.id, index, item.changes.length),
    content: fileChangePayload(item, change),
    isError: item.status === "failed" || item.status === "declined",
  }))
}

function itemToToolCalls(item: ThreadItem): TranscriptEntry[] {
  switch (item.type) {
    case "dynamicToolCall":
      return [genericDynamicToolCall(item.id, item.tool, dynamicToolPayload(item.arguments))]
    case "collabAgentToolCall":
      return [collabToolCall(item)]
    case "commandExecution":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: item.id,
          input: {
            command: item.command,
          },
          rawInput: item,
        },
      })]
    case "webSearch":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "web_search",
          toolName: "WebSearch",
          toolId: item.id,
          input: {
            query: webSearchQuery(item),
          },
          rawInput: item,
        },
      })]
    case "mcpToolCall":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "mcp_generic",
          toolName: `mcp__${item.server}__${item.tool}`,
          toolId: item.id,
          input: {
            server: item.server,
            tool: item.tool,
            payload: item.arguments ?? {},
          },
          rawInput: item.arguments ?? {},
        },
      })]
    case "fileChange":
      return fileChangeToToolCalls(item)
    case "plan":
      return []
    case "error":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "unknown_tool",
          toolName: "Error",
          toolId: item.id,
          input: {
            payload: item as unknown as Record<string, unknown>,
          },
          rawInput: item as unknown as Record<string, unknown>,
        },
      })]
    default:
      return []
  }
}

function commandExecutionOutputContent(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
  streamedOutput: string | undefined,
) {
  const completedOutput = item.aggregatedOutput ?? undefined
  if (streamedOutput === undefined) {
    return completedOutput ?? item
  }
  if (completedOutput === undefined) {
    return streamedOutput
  }
  return streamedOutput.length >= completedOutput.length ? streamedOutput : completedOutput
}

function itemToToolResults(item: ThreadItem, commandOutputByItemId?: Map<string, string>): TranscriptEntry[] {
  switch (item.type) {
    case "dynamicToolCall":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: dynamicContentToText(item.contentItems) || item,
        isError: item.status === "failed" || item.success === false,
      })]
    case "collabAgentToolCall":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item,
        isError: item.status === "failed",
      })]
    case "commandExecution":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: commandExecutionOutputContent(item, commandOutputByItemId?.get(item.id)),
        isError: (typeof item.exitCode === "number" && item.exitCode !== 0) || item.status === "failed" || item.status === "declined",
      })]
    case "webSearch":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item,
      })]
    case "mcpToolCall":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: contentFromMcpResult(item),
        isError: item.status === "failed",
      })]
    case "fileChange":
      return fileChangeToToolResults(item)
    case "plan":
      return []
    case "error":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item.message,
        isError: true,
      })]
    default:
      return []
  }
}

function codexUserMessageText(item: Extract<ThreadItem, { type: "userMessage" }>) {
  return item.content
    .flatMap((content) => content.type === "text" ? [content.text] : [])
    .join("\n")
    .trim()
}

export function transcriptFromCodexThread(thread: CodexThreadRecord, model = "codex"): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [codexSystemInitEntry(model)]

  for (const turn of thread.turns) {
    const startedAt = (turn.startedAt ?? thread.createdAt) * 1_000
    let sequence = 0
    const nextTimestamp = () => startedAt + sequence++

    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const content = codexUserMessageText(item)
        if (content) {
          entries.push(timestamped({ kind: "user_prompt", content }, nextTimestamp()))
        }
        continue
      }
      if (item.type === "agentMessage") {
        if (item.text.trim()) {
          entries.push(timestamped({ kind: "assistant_text", text: item.text }, nextTimestamp()))
        }
        continue
      }
      if (item.type === "plan" || item.type === "reasoning") {
        continue
      }

      for (const entry of itemToToolCalls(item)) {
        entries.push({ ...entry, createdAt: nextTimestamp() })
      }
      for (const entry of itemToToolResults(item)) {
        entries.push({ ...entry, createdAt: nextTimestamp() })
      }
    }

    entries.push(timestamped({
      kind: "result",
      subtype: turn.status === "failed" ? "error" : turn.status === "interrupted" ? "cancelled" : "success",
      isError: turn.status === "failed",
      durationMs: turn.durationMs ?? 0,
      result: turn.error?.message ?? "",
    }, (turn.completedAt ?? turn.startedAt ?? thread.updatedAt) * 1_000))
  }

  return entries
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private done = false

  push(value: T) {
    if (this.done) return
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver({ value, done: false })
      return
    }
    this.values.push(value)
  }

  finish() {
    if (this.done) return
    this.done = true
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()
      resolver?.({ value: undefined as T, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as T, done: true })
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve)
        })
      },
    }
  }
}

export class CodexAppServerManager {
  private readonly sessions = new Map<string, SessionContext>()
  private readonly chatIdByThreadId = new Map<string, string>()
  private readonly spawnProcess: SpawnCodexAppServer
  private connection: ConnectionContext | null = null
  private connectionPromise: Promise<ConnectionContext> | null = null

  constructor(args: { spawnProcess?: SpawnCodexAppServer } = {}) {
    this.spawnProcess = args.spawnProcess ?? ((cwd) => {
      const codexBinary = process.env.KANNA_CODEX_BINARY?.trim() || "codex"
      return spawn(codexBinary, ["app-server"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }) as unknown as CodexAppServerProcess
    })
  }

  private async createInitializedConnection(cwd: string) {
    const child = this.spawnProcess(cwd)
    const context: ConnectionContext = {
      child,
      pendingRequests: new Map(),
      stderrLines: [],
      closed: false,
    }
    this.connection = context
    this.attachListeners(context)

    try {
      await this.sendRequest(context, "initialize", {
        clientInfo: {
          name: "kanna_web",
          title: "Kanna",
          version: "0.41.7",
        },
        capabilities: {
          experimentalApi: true,
        },
      } satisfies InitializeParams)
      this.writeMessage(context, { method: "initialized" })
      return context
    } catch (error) {
      this.failConnection(context, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private async ensureConnection(cwd: string) {
    if (this.connection && !this.connection.closed) {
      return this.connection
    }
    if (!this.connectionPromise) {
      const promise = this.createInitializedConnection(cwd)
      this.connectionPromise = promise
      void promise.catch(() => {
        if (this.connectionPromise === promise) {
          this.connectionPromise = null
        }
      })
    }
    return await this.connectionPromise
  }

  private async withControlContext<T>(cwd: string, run: (context: ConnectionContext) => Promise<T>) {
    const context = await this.ensureConnection(cwd)
    try {
      return await run(context)
    } catch (error) {
      if (context.closed) {
        this.connectionPromise = null
      }
      throw error
    }
  }

  async startSession(args: StartCodexSessionArgs) {
    const existing = this.sessions.get(args.chatId)
    const approvalPolicy = args.approvalPolicy ?? "on-request"
    const sandboxMode = args.sandboxMode ?? "workspace-write"
    if (
      existing
      && !existing.closed
      && !existing.connection.closed
      && existing.cwd === args.cwd
      && existing.model === args.model
      && existing.serviceTier === args.serviceTier
      && existing.approvalPolicy === approvalPolicy
      && existing.sandboxMode === sandboxMode
      && (!args.sessionToken || args.sessionToken === existing.sessionToken)
      && !args.pendingForkSessionToken
    ) {
      return existing.sessionToken ?? undefined
    }

    const sessionToken = args.sessionToken ?? existing?.sessionToken ?? null
    if (existing) {
      this.stopSession(args.chatId)
    }

    const connection = await this.ensureConnection(args.cwd)
    const context: SessionContext = {
      chatId: args.chatId,
      cwd: args.cwd,
      connection,
      pendingTurn: null,
      sessionToken: null,
      model: args.model,
      serviceTier: args.serviceTier,
      approvalPolicy,
      sandboxMode,
      closed: false,
    }
    this.sessions.set(args.chatId, context)

    const threadParams = {
      model: args.model,
      cwd: args.cwd,
      serviceTier: args.serviceTier,
      approvalPolicy,
      sandbox: sandboxMode,
      experimentalRawEvents: true,
      persistExtendedHistory: false,
    } satisfies ThreadStartParams

    let response: ThreadStartResponse | ThreadResumeResponse | ThreadForkResponse
    if (args.pendingForkSessionToken) {
      response = await this.sendRequest<ThreadForkResponse>(context, "thread/fork", {
        threadId: args.pendingForkSessionToken,
        model: args.model,
        cwd: args.cwd,
        serviceTier: args.serviceTier,
          approvalPolicy,
          sandbox: sandboxMode,
          experimentalRawEvents: true,
          persistExtendedHistory: false,
        } satisfies ThreadForkParams)
    } else if (sessionToken) {
      try {
        response = await this.sendRequest<ThreadResumeResponse>(context, "thread/resume", {
          threadId: sessionToken,
          model: args.model,
          cwd: args.cwd,
          serviceTier: args.serviceTier,
          approvalPolicy,
          sandbox: sandboxMode,
          experimentalRawEvents: true,
          persistExtendedHistory: false,
        } satisfies ThreadResumeParams)
      } catch (error) {
        if (!isRecoverableResumeError(error)) {
          this.stopSession(args.chatId)
          throw error
        }
        response = await this.sendRequest<ThreadStartResponse>(context, "thread/start", threadParams)
      }
    } else {
      response = await this.sendRequest<ThreadStartResponse>(context, "thread/start", threadParams)
    }

    this.bindSessionThread(context, response.thread.id)
    return context.sessionToken
  }

  private bindSessionThread(context: SessionContext, threadId: string) {
    if (context.sessionToken) {
      this.chatIdByThreadId.delete(context.sessionToken)
    }
    context.sessionToken = threadId
    this.chatIdByThreadId.set(threadId, context.chatId)
  }

  async listThreads(cwd: string, archived = false, limit?: number): Promise<CodexThreadRecord[]> {
    if (limit !== undefined && limit <= 0) return []
    return await this.withControlContext(cwd, async (context) => {
      const threads: CodexThreadRecord[] = []
      let cursor: string | null = null
      do {
        const response: ThreadListResponse = await this.sendRequest<ThreadListResponse>(context, "thread/list", {
          cursor,
          limit: limit === undefined
            ? 100
            : Math.min(100, Math.max(1, limit - threads.length)),
          sortKey: "updated_at",
          sortDirection: "desc",
          archived,
          cwd,
        } satisfies ThreadListParams)
        threads.push(...response.data.map((thread) => ({ ...thread, archived })))
        cursor = response.nextCursor
      } while (cursor && (limit === undefined || threads.length < limit))
      return limit === undefined ? threads : threads.slice(0, limit)
    })
  }

  async listModels(cwd: string): Promise<CodexModelRecord[]> {
    return await this.withControlContext(cwd, async (context) => {
      const models: CodexModelRecord[] = []
      let cursor: string | null = null
      do {
        const response: ModelListResponse = await this.sendRequest<ModelListResponse>(context, "model/list", {
          cursor,
          limit: 100,
          includeHidden: false,
        })
        models.push(...response.data.filter((model) => !model.hidden))
        cursor = response.nextCursor
      } while (cursor)
      return models
    })
  }

  async readManagementSnapshot(cwd: string) {
    return await this.withControlContext(cwd, async (context) => {
      const [config, hooks, skills, plugins] = await Promise.all([
        this.sendRequest<ConfigReadResponse>(context, "config/read", { cwd, includeLayers: true }),
        this.sendRequest<HooksListResponse>(context, "hooks/list", { cwds: [cwd] }),
        this.sendRequest<SkillsListResponse>(context, "skills/list", { cwds: [cwd], forceReload: true }),
        this.sendRequest<PluginListResponse>(context, "plugin/list", { cwds: [cwd] }),
      ])
      const mcpServers: McpServerStatusListResponse["data"] = []
      let cursor: string | null = null
      do {
        const response: McpServerStatusListResponse = await this.sendRequest<McpServerStatusListResponse>(context, "mcpServerStatus/list", {
          cursor,
          limit: 100,
          detail: "toolsAndAuthOnly",
        })
        mcpServers.push(...response.data)
        cursor = response.nextCursor
      } while (cursor)

      return {
        cwd,
        config: config.config,
        configLayers: config.layers ?? [],
        skills: skills.data.flatMap((entry) => entry.skills),
        hooks: hooks.data.map((entry) => ({
          cwd: entry.cwd,
          warnings: entry.warnings,
          errors: entry.errors,
          hooks: entry.hooks.map((hook) => ({
            key: typeof hook.key === "string" ? hook.key : "",
            eventName: typeof hook.eventName === "string" ? hook.eventName : "unknown",
            command: typeof hook.command === "string" ? hook.command : null,
            sourcePath: typeof hook.sourcePath === "string" ? hook.sourcePath : "",
            source: typeof hook.source === "string" ? hook.source : "unknown",
            enabled: hook.enabled !== false,
            trustStatus: typeof hook.trustStatus === "string" ? hook.trustStatus : "unknown",
          })),
        })),
        mcpServers: mcpServers.map((server) => ({
          name: server.name,
          authStatus: server.authStatus,
          toolCount: Object.keys(server.tools ?? {}).length,
          resourceCount: server.resources?.length ?? 0,
        })),
        marketplaces: plugins.marketplaces.map((marketplace) => ({
          name: marketplace.name,
          path: marketplace.path,
          displayName: marketplace.interface?.displayName ?? null,
          plugins: marketplace.plugins.map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            installed: plugin.installed,
            enabled: plugin.enabled,
            availability: plugin.availability,
            description: plugin.interface?.shortDescription ?? null,
          })),
        })),
        marketplaceLoadErrors: plugins.marketplaceLoadErrors,
      }
    })
  }

  async writeConfigValue(cwd: string, keyPath: string, value: unknown) {
    return await this.withControlContext(cwd, (context) => this.sendRequest(context, "config/value/write", {
      keyPath,
      value,
      mergeStrategy: "upsert",
    }))
  }

  async toggleSkill(cwd: string, skillPath: string, enabled: boolean) {
    return await this.withControlContext(cwd, (context) => this.sendRequest(context, "skills/config/write", {
      path: skillPath,
      enabled,
    }))
  }

  async installPlugin(cwd: string, params: { pluginName: string; marketplacePath?: string | null; remoteMarketplaceName?: string | null }) {
    return await this.withControlContext(cwd, (context) => this.sendRequest(context, "plugin/install", params))
  }

  async uninstallPlugin(cwd: string, pluginId: string) {
    return await this.withControlContext(cwd, (context) => this.sendRequest(context, "plugin/uninstall", { pluginId }))
  }

  async addMarketplace(cwd: string, source: string) {
    return await this.withControlContext(cwd, (context) => this.sendRequest(context, "marketplace/add", { source }))
  }

  async removeMarketplace(cwd: string, marketplaceName: string) {
    return await this.withControlContext(cwd, (context) => this.sendRequest(context, "marketplace/remove", { marketplaceName }))
  }

  async upgradeMarketplaces(cwd: string, marketplaceName?: string | null) {
    return await this.withControlContext(cwd, (context) => this.sendRequest(context, "marketplace/upgrade", { marketplaceName }))
  }

  async startMcpOauth(cwd: string, name: string) {
    return await this.withControlContext(cwd, (context) => this.sendRequest<{ authorizationUrl: string }>(context, "mcpServer/oauth/login", { name }))
  }

  async reloadMcp(cwd: string) {
    return await this.withControlContext(cwd, (context) => this.sendRequest(context, "config/mcpServer/reload", undefined))
  }

  async readThread(cwd: string, threadId: string): Promise<CodexThreadRecord> {
    return await this.withControlContext(cwd, async (context) => {
      const response = await this.sendRequest<ThreadReadResponse>(context, "thread/read", {
        threadId,
        includeTurns: true,
      } satisfies ThreadReadParams)
      return response.thread
    })
  }

  async interruptThread(cwd: string, threadId: string) {
    return await this.withControlContext(cwd, async (context) => {
      const response = await this.sendRequest<ThreadReadResponse>(context, "thread/read", {
        threadId,
        includeTurns: true,
      } satisfies ThreadReadParams)
      const activeTurn = [...response.thread.turns].reverse().find((turn) => turn.status === "inProgress")
      if (!activeTurn) return false
      await this.sendRequest(context, "turn/interrupt", {
        threadId,
        turnId: activeTurn.id,
      } satisfies TurnInterruptParams)
      return true
    })
  }

  async readThreads(cwd: string, threadIds: string[]): Promise<CodexThreadRecord[]> {
    if (threadIds.length === 0) return []
    return await this.withControlContext(cwd, async (context) => {
      const threads: CodexThreadRecord[] = []
      for (const threadId of threadIds) {
        const response = await this.sendRequest<ThreadReadResponse>(context, "thread/read", {
          threadId,
          includeTurns: true,
        } satisfies ThreadReadParams)
        threads.push(response.thread)
      }
      return threads
    })
  }

  async setThreadName(chatId: string, cwd: string, threadId: string, name: string) {
    const active = this.sessions.get(chatId)
    if (active && !active.closed) {
      await this.sendRequest(active, "thread/name/set", { threadId, name } satisfies ThreadSetNameParams)
      return
    }
    await this.withControlContext(cwd, async (context) => {
      await this.sendRequest(context, "thread/name/set", { threadId, name } satisfies ThreadSetNameParams)
    })
  }

  async archiveThread(chatId: string, cwd: string, threadId: string) {
    const active = this.sessions.get(chatId)
    if (active && !active.closed) {
      await this.sendRequest(active, "thread/archive", { threadId } satisfies ThreadArchiveParams)
      return
    }
    await this.withControlContext(cwd, async (context) => {
      await this.sendRequest(context, "thread/archive", { threadId } satisfies ThreadArchiveParams)
    })
  }

  async unarchiveThread(chatId: string, cwd: string, threadId: string) {
    const active = this.sessions.get(chatId)
    if (active && !active.closed) {
      await this.sendRequest(active, "thread/unarchive", { threadId } satisfies ThreadArchiveParams)
      return
    }
    await this.withControlContext(cwd, async (context) => {
      await this.sendRequest(context, "thread/unarchive", { threadId } satisfies ThreadArchiveParams)
    })
  }

  async deleteThread(chatId: string, cwd: string, threadId: string) {
    const active = this.sessions.get(chatId)
    if (active && !active.closed) {
      await this.sendRequest(active, "thread/delete", { threadId } satisfies ThreadDeleteParams)
      this.stopSession(chatId)
      return
    }
    await this.withControlContext(cwd, async (context) => {
      await this.sendRequest(context, "thread/delete", { threadId } satisfies ThreadDeleteParams)
    })
  }

  async startTurn(args: StartCodexTurnArgs): Promise<HarnessTurn> {
    const context = this.requireSession(args.chatId)
    if (context.pendingTurn) {
      throw new Error("Codex turn is already running")
    }

    const goalCommand = parseGoalSlashCommand(args.content)
    if (goalCommand) {
      return await this.runGoalSlashCommand(context, args, goalCommand)
    }

    const { queue, pendingTurn } = this.createPendingTurn(context, args)
    context.pendingTurn = pendingTurn

    try {
      const response = await this.sendRequest<TurnStartResponse>(context, "turn/start", {
        threadId: context.sessionToken ?? "",
        input: codexTurnInput(args.content, args.attachments),
        approvalPolicy: args.approvalPolicy ?? "on-request",
        sandboxPolicy: codexSandboxPolicy(context.sandboxMode, context.cwd),
        model: args.model,
        effort: args.effort,
        serviceTier: args.serviceTier,
        collaborationMode: {
          mode: args.planMode ? "plan" : "default",
          settings: {
            model: args.model,
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      } satisfies TurnStartParams)
      if (context.pendingTurn) {
        context.pendingTurn.turnId = response.turn.id
      } else {
        pendingTurn.turnId = response.turn.id
      }
    } catch (error) {
      context.pendingTurn = null
      queue.finish()
      throw error
    }

    return {
      provider: "codex",
      stream: queue,
      interrupt: async () => {
        const pendingTurn = context.pendingTurn
        if (!pendingTurn) return

        context.pendingTurn = null
        pendingTurn.resolved = true
        pendingTurn.queue.finish()

        if (!pendingTurn.turnId || !context.sessionToken) return

        await this.sendRequest(context, "turn/interrupt", {
          threadId: context.sessionToken,
          turnId: pendingTurn.turnId,
        } satisfies TurnInterruptParams)
      },
      close: () => {},
    }
  }

  async startReview(args: StartCodexReviewArgs): Promise<HarnessTurn> {
    const context = this.requireSession(args.chatId)
    if (context.pendingTurn) {
      throw new Error("Codex turn is already running")
    }

    const { queue, pendingTurn } = this.createPendingTurn(context, {
      model: args.model,
      planMode: false,
      onToolRequest: args.onToolRequest,
      onApprovalRequest: args.onApprovalRequest,
    })
    context.pendingTurn = pendingTurn

    try {
      const response = await this.sendRequest<ReviewStartResponse>(context, "review/start", {
        threadId: context.sessionToken ?? "",
        target: args.target,
        delivery: "inline",
      } satisfies ReviewStartParams)
      pendingTurn.turnId = response.turn.id
    } catch (error) {
      context.pendingTurn = null
      queue.finish()
      throw error
    }

    return {
      provider: "codex",
      stream: queue,
      interrupt: async () => {
        const activeTurn = context.pendingTurn
        if (!activeTurn?.turnId) return
        await this.sendRequest(context, "turn/interrupt", {
          threadId: context.sessionToken ?? "",
          turnId: activeTurn.turnId,
        } satisfies TurnInterruptParams)
      },
      close: () => {
        if (context.pendingTurn === pendingTurn) {
          context.pendingTurn = null
        }
        queue.finish()
      },
    }
  }

  async getGoal(chatId: string) {
    const context = this.requireSession(chatId)
    if (!context.sessionToken) {
      return null
    }
    const response = await this.sendRequest<ThreadGoalGetResponse>(context, "thread/goal/get", {
      threadId: context.sessionToken,
    } satisfies ThreadGoalGetParams)
    return response.goal
  }

  async steerTurn(chatId: string, content: string, attachments: ChatAttachment[] = []) {
    const context = this.requireSession(chatId)
    if (!context.pendingTurn?.turnId || !context.sessionToken) {
      throw new Error("Codex turn is not ready to steer")
    }
    const response = await this.sendRequest<TurnSteerResponse>(context, "turn/steer", {
      threadId: context.sessionToken,
      expectedTurnId: context.pendingTurn.turnId,
      input: codexTurnInput(content, attachments),
    } satisfies TurnSteerParams)
    return response.turnId
  }

  async setGoal(
    chatId: string,
    params: Omit<ThreadGoalSetParams, "threadId">
  ) {
    const context = this.requireSession(chatId)
    if (!context.sessionToken) {
      throw new Error("Codex session not started")
    }
    const response = await this.sendRequest<ThreadGoalSetResponse>(context, "thread/goal/set", {
      threadId: context.sessionToken,
      ...params,
    } satisfies ThreadGoalSetParams)
    return response.goal
  }

  async clearGoal(chatId: string) {
    const context = this.requireSession(chatId)
    if (!context.sessionToken) {
      return false
    }
    const response = await this.sendRequest<ThreadGoalClearResponse>(context, "thread/goal/clear", {
      threadId: context.sessionToken,
    } satisfies ThreadGoalClearParams)
    return response.cleared
  }

  private async runGoalSlashCommand(
    context: SessionContext,
    args: StartCodexTurnArgs,
    command: GoalSlashCommand,
  ): Promise<HarnessTurn> {
    if (!context.sessionToken) {
      throw new Error("Codex session not started")
    }

    if (command.kind === "set") {
      const { queue, pendingTurn } = this.createPendingTurn(context, {
        ...args,
        planMode: false,
      })
      context.pendingTurn = pendingTurn

      try {
        const goal = await this.setGoal(context.chatId, {
          objective: command.objective,
          status: "active",
          tokenBudget: null,
        })
        queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "assistant_text",
            text: `Goal set: ${goal.objective}`,
          }),
        })
      } catch (error) {
        context.pendingTurn = null
        queue.finish()
        throw error
      }

      return {
        provider: "codex",
        stream: queue,
        interrupt: async () => {
          const activeTurn = context.pendingTurn
          if (!activeTurn) return

          context.pendingTurn = null
          activeTurn.resolved = true
          activeTurn.queue.finish()

          if (!activeTurn.turnId || !context.sessionToken) return

          await this.sendRequest(context, "turn/interrupt", {
            threadId: context.sessionToken,
            turnId: activeTurn.turnId,
          } satisfies TurnInterruptParams)
        },
        close: () => {},
      }
    }

    const queue = new AsyncQueue<HarnessEvent>()
    queue.push({ type: "session_token", sessionToken: context.sessionToken })
    queue.push({ type: "transcript", entry: codexSystemInitEntry(args.model) })

    let message: string
    if (command.kind === "clear") {
      const cleared = await this.clearGoal(context.chatId)
      message = cleared ? "Goal cleared." : "No active goal to clear."
    } else {
      const goal = await this.getGoal(context.chatId)
      message = goal
        ? `Goal: ${goal.objective}\nStatus: ${goal.status}`
        : "No active goal."
    }

    queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "assistant_text",
        text: message,
      }),
    })
    queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "result",
        subtype: "success",
        isError: false,
        durationMs: 0,
        result: "",
      }),
    })
    queue.finish()

    return {
      provider: "codex",
      stream: queue,
      interrupt: async () => {},
      close: () => {},
    }
  }

  private createPendingTurn(
    context: SessionContext,
    args: Pick<StartCodexTurnArgs, "model" | "planMode" | "onToolRequest" | "onApprovalRequest">,
  ) {
    const queue = new AsyncQueue<HarnessEvent>()
    if (context.sessionToken) {
      queue.push({ type: "session_token", sessionToken: context.sessionToken })
    }
    queue.push({ type: "transcript", entry: codexSystemInitEntry(args.model) })

    const pendingTurn: PendingTurn = {
      turnId: null,
      model: args.model,
      planMode: args.planMode,
      queue,
      startedToolIds: new Set(),
      handledDynamicToolIds: new Set(),
      latestPlanExplanation: null,
      latestPlanSteps: [],
      latestPlanText: null,
      planTextByItemId: new Map(),
      commandOutputByItemId: new Map(),
      todoSequence: 0,
      pendingWebSearchResultToolId: null,
      resolved: false,
      onToolRequest: args.onToolRequest,
      onApprovalRequest: args.onApprovalRequest,
    }

    return { queue, pendingTurn }
  }

  async generateStructured(args: GenerateStructuredArgs): Promise<string | null> {
    const chatId = `quick-${randomUUID()}`
    let turn: HarnessTurn | null = null
    let assistantText = ""
    let resultText = ""

    try {
      await this.startSession({
        chatId,
        cwd: args.cwd,
        model: args.model ?? "gpt-5.5",
        serviceTier: args.serviceTier ?? "fast",
        sessionToken: null,
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
      })

      turn = await this.startTurn({
        chatId,
        model: args.model ?? "gpt-5.5",
        effort: args.effort,
        serviceTier: args.serviceTier ?? "fast",
        content: args.prompt,
        planMode: false,
        approvalPolicy: "never",
        onToolRequest: async () => ({}),
      })

      for await (const event of turn.stream) {
        if (event.type !== "transcript" || !event.entry) continue
        if (event.entry.kind === "assistant_text") {
          assistantText += assistantText ? `\n${event.entry.text}` : event.entry.text
        }
        if (event.entry.kind === "result" && !event.entry.isError && event.entry.result.trim()) {
          resultText = event.entry.result
        }
      }

      const candidate = assistantText.trim() || resultText.trim()
      return candidate || null
    } finally {
      turn?.close()
      this.stopSession(chatId)
    }
  }

  stopSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context) return
    context.closed = true
    context.pendingTurn?.queue.finish()
    context.pendingTurn = null
    this.sessions.delete(chatId)
    if (context.sessionToken) {
      this.chatIdByThreadId.delete(context.sessionToken)
    }
  }

  stopAll() {
    for (const chatId of [...this.sessions.keys()]) {
      this.stopSession(chatId)
    }
    const connection = this.connection
    this.connection = null
    this.connectionPromise = null
    if (!connection || connection.closed) return
    connection.closed = true
    for (const pending of connection.pendingRequests.values()) {
      pending.reject(new Error("Codex app-server stopped"))
    }
    connection.pendingRequests.clear()
    try {
      connection.child.kill("SIGKILL")
    } catch {
      // ignore kill failures
    }
  }

  private requireSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context || context.closed || context.connection.closed) {
      throw new Error("Codex session not started")
    }
    return context
  }

  private attachListeners(context: ConnectionContext) {
    const lines = createInterface({ input: context.child.stdout })
    void (async () => {
      for await (const line of lines) {
        const parsed = parseJsonLine(line)
        if (!parsed) continue

        if (isJsonRpcResponse(parsed)) {
          this.handleResponse(context, parsed)
          continue
        }

        if (isServerRequest(parsed)) {
          void this.handleServerRequest(context, parsed)
          continue
        }

        if (isServerNotification(parsed)) {
          void this.handleNotification(context, parsed)
        }
      }
    })()

    const stderr = createInterface({ input: context.child.stderr })
    void (async () => {
      for await (const line of stderr) {
        if (line.trim()) {
          context.stderrLines.push(line.trim())
        }
      }
    })()

    context.child.on("error", (error) => {
      this.failConnection(context, error.message)
    })

    context.child.on("close", (code) => {
      if (context.closed) return
      queueMicrotask(() => {
        if (context.closed) return
        const message = context.stderrLines.at(-1) || `Codex app-server exited with code ${code ?? 1}`
        this.failConnection(context, message)
      })
    })
  }

  private handleResponse(context: ConnectionContext, response: JsonRpcResponse) {
    const pending = context.pendingRequests.get(response.id)
    if (!pending) return
    context.pendingRequests.delete(response.id)
    if (response.error) {
      pending.reject(new Error(`${pending.method} failed: ${response.error.message ?? "Unknown error"}`))
      return
    }
    pending.resolve(response.result)
  }

  private sessionForThreadId(threadId: string | null | undefined) {
    if (!threadId) return null
    const chatId = this.chatIdByThreadId.get(threadId)
    return chatId ? this.sessions.get(chatId) ?? null : null
  }

  private sessionForTurnId(turnId: string | null | undefined) {
    if (!turnId) return null
    for (const context of this.sessions.values()) {
      if (context.pendingTurn?.turnId === turnId) return context
    }
    return null
  }

  private async handleServerRequest(connection: ConnectionContext, request: ServerRequest) {
    const context = this.sessionForThreadId(request.params.threadId)
    const pendingTurn = context?.pendingTurn
    if (!context || !pendingTurn) {
      this.writeMessage(connection, {
        id: request.id,
        error: {
          message: "No active turn",
        },
      })
      return
    }

    if (request.method === "mcpServer/elicitation/request") {
      const actionRequest: HarnessToolRequest = {
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: `${String(request.id)}:mcp-action`,
          input: {
            questions: [{
              id: "action",
              header: "MCP request",
              question: `${request.params.serverName}: ${request.params.message}${request.params.url ? `\n\n${request.params.url}` : ""}`,
              options: [
                { label: "Accept", description: "Continue with this MCP request" },
                { label: "Decline", description: "Decline without cancelling the Codex turn" },
                { label: "Cancel", description: "Cancel this MCP request" },
              ],
              multiSelect: false,
            }],
          },
          rawInput: { ...request.params },
        },
      }
      pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "tool_call", tool: actionRequest.tool }) })
      const actionAnswer = questionAnswer(await pendingTurn.onToolRequest(actionRequest), "action")
      const action = actionAnswer === "Accept" ? "accept" : actionAnswer === "Decline" ? "decline" : "cancel"
      if (action !== "accept" || request.params.mode === "url") {
        this.writeMessage(context, { id: request.id, result: { action, content: null, _meta: null } })
        return
      }

      const properties = request.params.requestedSchema?.properties ?? {}
      const questions: AskUserQuestionItem[] = Object.entries(properties).map(([id, schema]) => ({
        id,
        header: schema.title || id,
        question: schema.description || schema.title || id,
        options: Array.isArray(schema.enum)
          ? schema.enum.map((value) => ({ label: String(value) }))
          : undefined,
        multiSelect: schema.type === "array",
      }))
      let content: Record<string, unknown> = {}
      if (questions.length > 0) {
        const formRequest: HarnessToolRequest = {
          tool: {
            kind: "tool",
            toolKind: "ask_user_question",
            toolName: "AskUserQuestion",
            toolId: `${String(request.id)}:mcp-form`,
            input: { questions },
            rawInput: { ...request.params },
          },
        }
        pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "tool_call", tool: formRequest.tool }) })
        const formResult = await pendingTurn.onToolRequest(formRequest)
        content = Object.fromEntries(Object.entries(properties).map(([id, schema]) => [
          id,
          parseElicitationValue(questionAnswerValue(formResult, id), schema.type),
        ]))
      }
      this.writeMessage(context, { id: request.id, result: { action: "accept", content, _meta: null } })
      return
    }

    if (request.method === "item/permissions/requestApproval") {
      const permissionsRequest = approvalQuestionTool(
        `${request.params.itemId}:permissions`,
        `Allow additional permissions for this turn?\n\n${JSON.stringify(request.params.permissions, null, 2)}`,
        request.params.reason,
      )
      pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "tool_call", tool: permissionsRequest.tool }) })
      const answer = approvalAnswer(await pendingTurn.onToolRequest(permissionsRequest))
      const approved = answer === "Approve once" || answer === "Approve for session"
      this.writeMessage(context, {
        id: request.id,
        result: {
          permissions: approved ? {
            ...(request.params.permissions.network ? { network: request.params.permissions.network } : {}),
            ...(request.params.permissions.fileSystem ? { fileSystem: request.params.permissions.fileSystem } : {}),
          } : {},
          scope: answer === "Approve for session" ? "session" : "turn",
        },
      })
      return
    }

    if (request.method === "item/tool/requestUserInput") {
      const questions = toAskUserQuestionItems(request.params)
      const toolId = request.params.itemId
      const toolRequest: HarnessToolRequest = {
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId,
          input: { questions },
          rawInput: {
            questions: request.params.questions,
          },
        },
      }
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_call",
          tool: toolRequest.tool,
        }),
      })

      const result = await pendingTurn.onToolRequest(toolRequest)
      this.writeMessage(context, {
        id: request.id,
        result: toToolRequestUserInputResponse(result, request.params.questions),
      })
      return
    }

    if (request.method === "item/tool/call") {
      pendingTurn.handledDynamicToolIds.add(request.params.callId)
      if (request.params.tool === "update_plan") {
        const args = asRecord(request.params.arguments)
        const plan = Array.isArray(args?.plan) ? args.plan : []
        const steps: TurnPlanStep[] = plan
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .map((entry) => {
            const status: TurnPlanStep["status"] =
              entry.status === "completed"
                ? "completed"
                : entry.status === "inProgress" || entry.status === "in_progress"
                  ? "inProgress"
                  : "pending"
            return {
              step: typeof entry.step === "string" ? entry.step : "",
              status,
            }
          })
          .filter((step) => step.step.length > 0)

        if (steps.length > 0) {
          pendingTurn.latestPlanSteps = steps
          pendingTurn.latestPlanExplanation = typeof args?.explanation === "string" ? args.explanation : pendingTurn.latestPlanExplanation
          pendingTurn.queue.push({
            type: "transcript",
            entry: todoToolCall(request.params.callId, steps),
          })
          pendingTurn.queue.push({
            type: "transcript",
            entry: timestamped({
              kind: "tool_result",
              toolId: request.params.callId,
              content: "",
            }),
          })
        }

        this.writeMessage(context, {
          id: request.id,
          result: {
            contentItems: [],
            success: true,
          } satisfies DynamicToolCallResponse,
        })
        return
      }

      const payload = dynamicToolPayload(request.params.arguments)
      pendingTurn.queue.push({
        type: "transcript",
        entry: genericDynamicToolCall(request.params.callId, request.params.tool, payload),
      })
      const errorMessage = `Unsupported dynamic tool call: ${request.params.tool}`
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_result",
          toolId: request.params.callId,
          content: errorMessage,
          isError: true,
        }),
      })
      this.writeMessage(context, {
        id: request.id,
        result: {
          contentItems: [{ type: "inputText", text: errorMessage }],
          success: false,
        } satisfies DynamicToolCallResponse,
      })
      return
    }

    if (request.method === "item/commandExecution/requestApproval") {
      const decision = pendingTurn.onApprovalRequest
        ? await pendingTurn.onApprovalRequest({
            requestId: request.id,
            kind: "command_execution",
            params: request.params,
          })
        : await (async (): Promise<CommandExecutionApprovalDecision> => {
            const toolRequest = approvalQuestionTool(
              `${request.params.itemId}:approval`,
              `Allow Codex to run this command?\n\n${request.params.command ?? "Command details unavailable"}`,
              request.params.reason,
            )
            pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "tool_call", tool: toolRequest.tool }) })
            const answer = approvalAnswer(await pendingTurn.onToolRequest(toolRequest))
            if (answer === "Approve once") return "accept"
            if (answer === "Approve for session") return "acceptForSession"
            if (answer === "Cancel turn") return "cancel"
            return "decline"
          })()
      this.writeMessage(context, {
        id: request.id,
        result: {
          decision,
        } satisfies CommandExecutionRequestApprovalResponse,
      })
      return
    }

    const decision = pendingTurn.onApprovalRequest
      ? await pendingTurn.onApprovalRequest({
          requestId: request.id,
          kind: "file_change",
          params: request.params,
        })
      : await (async (): Promise<FileChangeApprovalDecision> => {
          const toolRequest = approvalQuestionTool(
            `${request.params.itemId}:approval`,
            `Allow Codex to modify files${request.params.grantRoot ? ` under ${request.params.grantRoot}` : ""}?`,
            request.params.reason,
          )
          pendingTurn.queue.push({ type: "transcript", entry: timestamped({ kind: "tool_call", tool: toolRequest.tool }) })
          const answer = approvalAnswer(await pendingTurn.onToolRequest(toolRequest))
          if (answer === "Approve once") return "accept"
          if (answer === "Approve for session") return "acceptForSession"
          if (answer === "Cancel turn") return "cancel"
          return "decline"
        })()
    this.writeMessage(context, {
      id: request.id,
      result: {
        decision,
      } satisfies FileChangeRequestApprovalResponse,
    })
  }

  private async handleNotification(_connection: ConnectionContext, notification: ServerNotification) {
    const params = notification.params as {
      threadId?: string | null
      turnId?: string | null
      thread?: { id?: string }
    }
    if (notification.method === "thread/started") {
      const context = this.sessionForThreadId(notification.params.thread.id)
      if (!context) return
      this.bindSessionThread(context, notification.params.thread.id)
      if (context.pendingTurn) {
        context.pendingTurn.queue.push({
          type: "session_token",
          sessionToken: notification.params.thread.id,
        })
      }
      return
    }

    if (notification.method === "warning" && !notification.params.threadId) {
      for (const context of this.sessions.values()) {
        context.pendingTurn?.queue.push({
          type: "transcript",
          entry: timestamped({ kind: "status", status: notification.params.message }),
        })
      }
      return
    }

    const context = this.sessionForThreadId(params.threadId)
      ?? this.sessionForTurnId(params.turnId)

    if (notification.method === "error") {
      const targets = context
        ? [context]
        : [...this.sessions.values()].filter((session) => session.pendingTurn)
      for (const target of targets) {
        if (notification.params.willRetry) {
          target.pendingTurn?.queue.push({
            type: "transcript",
            entry: timestamped({ kind: "status", status: notification.params.error.message }),
          })
        } else {
          this.failSession(target, notification.params.error.message)
        }
      }
      return
    }

    if (!context) return

    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return

    switch (notification.method) {
      case "thread/tokenUsage/updated":
        this.handleTokenUsageUpdated(pendingTurn, notification.params)
        return
      case "turn/plan/updated":
        this.handlePlanUpdated(pendingTurn, notification.params)
        return
      case "turn/started":
        pendingTurn.turnId = notification.params.turn.id
        return
      case "item/started":
        this.handleItemStarted(pendingTurn, notification.params)
        return
      case "item/completed":
        this.handleItemCompleted(pendingTurn, notification.params)
        return
      case "item/commandExecution/outputDelta":
        this.handleCommandExecutionOutputDelta(pendingTurn, notification.params)
        return
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(pendingTurn, notification.params)
        return
      case "item/reasoning/summaryTextDelta":
        this.handleReasoningSummaryDelta(pendingTurn, notification.params)
        return
      case "item/mcpToolCall/progress":
        this.handleMcpProgress(pendingTurn, notification.params)
        return
      case "turn/diff/updated":
        this.handleTurnDiffUpdated(pendingTurn, notification.params)
        return
      case "item/fileChange/patchUpdated":
        this.handleFileChangePatchUpdated(pendingTurn, notification.params)
        return
      case "rawResponseItem/completed":
        this.handleRawResponseItemCompleted(pendingTurn, notification.params)
        return
      case "item/plan/delta":
        this.handlePlanDelta(pendingTurn, notification.params)
        return
      case "turn/completed":
        await this.handleTurnCompleted(context, notification.params)
        return
      case "thread/compacted":
        this.handleContextCompacted(pendingTurn, notification.params)
        return
      case "warning":
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({ kind: "status", status: notification.params.message }),
        })
        return
      default:
        return
    }
  }

  private handleItemStarted(pendingTurn: PendingTurn, notification: ItemStartedNotification) {
    if (notification.item.type === "plan") {
      pendingTurn.planTextByItemId.set(notification.item.id, notification.item.text)
      pendingTurn.latestPlanText = notification.item.text
      return
    }

    if (
      notification.item.type === "commandExecution"
      || notification.item.type === "webSearch"
      || notification.item.type === "mcpToolCall"
      || notification.item.type === "dynamicToolCall"
      || notification.item.type === "collabAgentToolCall"
      || notification.item.type === "fileChange"
      || notification.item.type === "error"
    ) {
      if (pendingTurn.handledDynamicToolIds.has(notification.item.id)) {
        return
      }
      if (notification.item.type === "webSearch" && !webSearchQuery(notification.item)) {
        return
      }
    }

    const entries = itemToToolCalls(notification.item)
    for (const entry of entries) {
      if (entry.kind === "tool_call") {
        pendingTurn.startedToolIds.add(entry.tool.toolId)
      }
      pendingTurn.queue.push({ type: "transcript", entry })
    }
  }

  private handleTurnDiffUpdated(pendingTurn: PendingTurn, notification: TurnDiffUpdatedNotification) {
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "turn_diff",
        turnId: notification.turnId,
        diff: notification.diff,
      }),
    })
  }

  private handleFileChangePatchUpdated(pendingTurn: PendingTurn, notification: FileChangePatchUpdatedNotification) {
    const item: FileChangeItem = {
      type: "fileChange",
      id: notification.itemId,
      changes: notification.changes,
      status: "inProgress",
    }
    for (const entry of fileChangeToToolCalls(item)) {
      pendingTurn.queue.push({ type: "transcript", entry })
    }
  }

  private handleItemCompleted(pendingTurn: PendingTurn, notification: ItemCompletedNotification) {
    if (notification.item.type === "agentMessage") {
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "assistant_text",
          text: notification.item.text,
          itemId: notification.item.id,
        }),
      })
      if (pendingTurn.pendingWebSearchResultToolId && notification.item.text.trim()) {
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "tool_result",
            toolId: pendingTurn.pendingWebSearchResultToolId,
            content: notification.item.text,
          }),
        })
        pendingTurn.pendingWebSearchResultToolId = null
      }
      return
    }

    if (notification.item.type === "plan") {
      pendingTurn.planTextByItemId.set(notification.item.id, notification.item.text)
      pendingTurn.latestPlanText = notification.item.text
      return
    }

    if (pendingTurn.handledDynamicToolIds.has(notification.item.id)) {
      return
    }

    const startedEntries = itemToToolCalls(notification.item)
    for (const entry of startedEntries) {
      if (entry.kind !== "tool_call") {
        continue
      }
      if (pendingTurn.startedToolIds.has(entry.tool.toolId)) {
        continue
      }
      pendingTurn.startedToolIds.add(entry.tool.toolId)
      pendingTurn.queue.push({ type: "transcript", entry })
    }

    const resultEntries = itemToToolResults(notification.item, pendingTurn.commandOutputByItemId)
    for (const entry of resultEntries) {
      pendingTurn.queue.push({ type: "transcript", entry })
      if (notification.item.type === "webSearch" && entry.kind === "tool_result" && !entry.isError) {
        pendingTurn.pendingWebSearchResultToolId = notification.item.id
      }
    }
  }

  private handlePlanUpdated(pendingTurn: PendingTurn, notification: TurnPlanUpdatedNotification) {
    pendingTurn.latestPlanExplanation = notification.explanation ?? null
    pendingTurn.latestPlanSteps = notification.plan
    if (notification.plan.length === 0) {
      return
    }
    pendingTurn.todoSequence += 1
    pendingTurn.queue.push({
      type: "transcript",
      entry: todoToolCall(
        `${notification.turnId}:todo-${pendingTurn.todoSequence}`,
        notification.plan
      ),
    })
  }

  private handlePlanDelta(pendingTurn: PendingTurn, notification: PlanDeltaNotification) {
    const current = pendingTurn.planTextByItemId.get(notification.itemId) ?? ""
    const next = `${current}${notification.delta}`
    pendingTurn.planTextByItemId.set(notification.itemId, next)
    pendingTurn.latestPlanText = next
  }

  private handleCommandExecutionOutputDelta(
    pendingTurn: PendingTurn,
    notification: CommandExecutionOutputDeltaNotification,
  ) {
    const current = pendingTurn.commandOutputByItemId.get(notification.itemId) ?? ""
    pendingTurn.commandOutputByItemId.set(notification.itemId, `${current}${notification.delta}`)
  }

  private handleAgentMessageDelta(
    pendingTurn: PendingTurn,
    notification: AgentMessageDeltaNotification,
  ) {
    if (!notification.delta) return
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "assistant_text_delta",
        itemId: notification.itemId,
        delta: notification.delta,
      }),
    })
  }

  private handleReasoningSummaryDelta(
    pendingTurn: PendingTurn,
    notification: ReasoningSummaryTextDeltaNotification,
  ) {
    if (!notification.delta) return
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "reasoning_summary_delta",
        itemId: notification.itemId,
        delta: notification.delta,
      }),
    })
  }

  private handleMcpProgress(
    pendingTurn: PendingTurn,
    notification: McpToolCallProgressNotification,
  ) {
    if (!notification.message) return
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({ kind: "status", status: notification.message }),
    })
  }

  private handleRawResponseItemCompleted(
    pendingTurn: PendingTurn,
    notification: RawResponseItemCompletedNotification,
  ) {
    if (notification.item.type !== "function_call_output") {
      return
    }
    if (typeof notification.item.call_id !== "string" || typeof notification.item.output !== "string") {
      return
    }

    const output = commandOutputFromRawFunctionCallOutput(notification.item.output)
    if (output === null) {
      return
    }

    const current = pendingTurn.commandOutputByItemId.get(notification.item.call_id)
    if (current === undefined || output.length >= current.length) {
      pendingTurn.commandOutputByItemId.set(notification.item.call_id, output)
    }
  }

  private handleContextCompacted(pendingTurn: PendingTurn, _notification: ContextCompactedNotification) {
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({ kind: "compact_boundary" }),
    })
  }

  private handleTokenUsageUpdated(
    pendingTurn: PendingTurn,
    notification: ThreadTokenUsageUpdatedNotification,
  ) {
    const usage = normalizeCodexTokenUsage(notification)
    if (!usage) {
      return
    }

    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "context_window_updated",
        usage,
      }),
    })
  }

  private async handleTurnCompleted(context: SessionContext, notification: TurnCompletedNotification) {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return
    const status = notification.turn.status
    const isCancelled = status === "interrupted"
    const isError = status === "failed"
    pendingTurn.pendingWebSearchResultToolId = null

    if (!isCancelled && !isError && pendingTurn.planMode) {
      const planText = pendingTurn.latestPlanText?.trim()
        || renderPlanMarkdownFromSteps(pendingTurn.latestPlanSteps).trim()

      if (planText) {
        pendingTurn.turnId = null
        const tool = {
          kind: "tool" as const,
          toolKind: "exit_plan_mode" as const,
          toolName: "ExitPlanMode",
          toolId: `${notification.turn.id}:exit-plan`,
          input: {
            plan: planText,
            summary: pendingTurn.latestPlanExplanation ?? undefined,
          },
          rawInput: {
            plan: planText,
            summary: pendingTurn.latestPlanExplanation ?? undefined,
          },
        }
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "tool_call",
            tool,
          }),
        })
        await pendingTurn.onToolRequest({ tool })
        pendingTurn.resolved = true
        pendingTurn.queue.finish()
        context.pendingTurn = null
        return
      }
    }

    pendingTurn.resolved = true
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "result",
        subtype: isCancelled ? "cancelled" : isError ? "error" : "success",
        isError,
        durationMs: 0,
        result: notification.turn.error?.message ?? "",
      }),
    })
    pendingTurn.queue.finish()
    context.pendingTurn = null
  }

  private failSession(context: SessionContext, message: string) {
    const pendingTurn = context.pendingTurn
    if (pendingTurn && !pendingTurn.resolved) {
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: message,
        }),
      })
      pendingTurn.queue.finish()
      context.pendingTurn = null
    }
  }

  private failConnection(context: ConnectionContext, message: string) {
    if (context.closed) return
    context.closed = true
    for (const pending of context.pendingRequests.values()) {
      pending.reject(new Error(message))
    }
    context.pendingRequests.clear()
    for (const [chatId, session] of [...this.sessions.entries()]) {
      if (session.connection !== context) continue
      this.failSession(session, message)
      session.closed = true
      if (session.sessionToken) {
        this.chatIdByThreadId.delete(session.sessionToken)
      }
      this.sessions.delete(chatId)
    }
    if (this.connection === context) {
      this.connection = null
      this.connectionPromise = null
    }
  }

  private connectionFor(context: SessionContext | ConnectionContext) {
    return "connection" in context ? context.connection : context
  }

  private async sendRequest<TResult>(context: SessionContext | ConnectionContext, method: string, params: unknown): Promise<TResult> {
    const connection = this.connectionFor(context)
    if (connection.closed) {
      throw new Error("Codex app-server connection is closed")
    }
    const id = randomUUID()
    const promise = new Promise<TResult>((resolve, reject) => {
      connection.pendingRequests.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })
    this.writeMessage(connection, {
      id,
      method,
      params,
    })
    return await promise
  }

  private writeMessage(context: SessionContext | ConnectionContext, message: Record<string, unknown>) {
    const connection = this.connectionFor(context)
    connection.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
}

let processSharedCodexAppServerManager: CodexAppServerManager | null = null

/**
 * Returns the single Codex app-server manager owned by this Kanna process.
 * Explicitly constructed managers remain available for isolated tests and
 * embedding, while normal runtime consumers share one subprocess connection.
 */
export function getProcessSharedCodexAppServerManager() {
  processSharedCodexAppServerManager ??= new CodexAppServerManager()
  return processSharedCodexAppServerManager
}

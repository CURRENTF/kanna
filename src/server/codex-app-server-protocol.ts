// Minimal typed subset vendored from `codex app-server generate-ts`.
// Keep names and field shapes aligned with the official app-server protocol.

import type { CodexGoal, CodexGoalStatus, CodexReasoningEffort, CodexReviewTarget, ServiceTier } from "../shared/types"

export type CodexRequestId = string | number

export interface JsonRpcResponse<TResult = unknown> {
  id: CodexRequestId
  result?: TResult
  error?: {
    code?: number
    message?: string
  }
}

export interface InitializeParams {
  clientInfo: {
    name: string
    title: string
    version: string
  }
  capabilities: {
    experimentalApi: boolean
  }
}

export interface ThreadStartParams {
  model?: string | null
  cwd?: string | null
  serviceTier?: ServiceTier | null
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null
  experimentalRawEvents: boolean
  persistExtendedHistory: boolean
}

export interface ThreadResumeParams {
  threadId: string
  model?: string | null
  cwd?: string | null
  serviceTier?: ServiceTier | null
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null
  experimentalRawEvents?: boolean
  persistExtendedHistory: boolean
}

export interface ThreadForkParams {
  threadId: string
  model?: string | null
  cwd?: string | null
  serviceTier?: ServiceTier | null
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null
  ephemeral?: boolean
  experimentalRawEvents?: boolean
  persistExtendedHistory: boolean
}

export interface TextUserInput {
  type: "text"
  text: string
  text_elements: []
}

export interface LocalImageUserInput {
  type: "localImage"
  path: string
  detail?: "auto" | "low" | "high" | "original"
}

export interface MentionUserInput {
  type: "mention"
  name: string
  path: string
}

export type CodexUserInput = TextUserInput | LocalImageUserInput | MentionUserInput

export interface CollaborationMode {
  mode: "default" | "plan"
  settings: {
    model: string | null
    reasoning_effort: ReasoningEffort | null
    developer_instructions: string | null
  }
}

export type ReasoningEffort = CodexReasoningEffort

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite"
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

export interface TurnStartParams {
  threadId: string
  input: CodexUserInput[]
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted" | null
  sandboxPolicy?: SandboxPolicy | null
  model?: string | null
  effort?: ReasoningEffort | null
  serviceTier?: ServiceTier | null
  collaborationMode?: CollaborationMode | null
}

export interface TurnInterruptParams {
  threadId: string
  turnId: string
}

export interface TurnSteerParams {
  threadId: string
  expectedTurnId: string
  input: CodexUserInput[]
}

export interface TurnSteerResponse {
  turnId: string
}

export type ThreadGoalStatus = CodexGoalStatus
export type ThreadGoal = CodexGoal

export interface ThreadGoalSetParams {
  threadId: string
  objective?: string | null
  status?: ThreadGoalStatus | null
  tokenBudget?: number | null
}

export interface ThreadGoalSetResponse {
  goal: ThreadGoal
}

export interface ThreadGoalGetParams {
  threadId: string
}

export interface ThreadGoalGetResponse {
  goal: ThreadGoal | null
}

export interface ThreadGoalClearParams {
  threadId: string
}

export interface ThreadGoalClearResponse {
  cleared: boolean
}

export interface ThreadSummary {
  id: string
}

export interface CodexThreadRecord {
  id: string
  preview: string
  cwd: string
  modelProvider: string
  createdAt: number
  updatedAt: number
  name: string | null
  archived?: boolean
  turns: Array<{
    id: string
    status: "inProgress" | "completed" | "failed" | "interrupted"
    error: { message?: string } | null
    startedAt: number | null
    completedAt: number | null
    durationMs: number | null
    items: ThreadItem[]
  }>
}

export interface ThreadListParams {
  cursor?: string | null
  limit?: number | null
  sortKey?: "created_at" | "updated_at" | null
  sortDirection?: "asc" | "desc" | null
  archived?: boolean | null
  cwd?: string | string[] | null
  searchTerm?: string | null
}

export interface ThreadListResponse {
  data: CodexThreadRecord[]
  nextCursor: string | null
}

export interface ThreadReadParams {
  threadId: string
  includeTurns?: boolean
}

export interface ThreadReadResponse {
  thread: CodexThreadRecord
}

export interface ThreadSetNameParams {
  threadId: string
  name: string
}

export interface ThreadArchiveParams {
  threadId: string
}

export interface ThreadDeleteParams {
  threadId: string
}

export interface CodexModelRecord {
  id: string
  model: string
  displayName: string
  hidden: boolean
  isDefault: boolean
  supportedReasoningEfforts: Array<{ reasoningEffort: ReasoningEffort; description?: string }>
  serviceTiers: Array<{ id: string; displayName?: string }>
}

export interface ModelListResponse {
  data: CodexModelRecord[]
  nextCursor: string | null
}

export interface ThreadStartResponse {
  thread: ThreadSummary
  model: string
  reasoningEffort: ReasoningEffort | null
}

export type ThreadResumeResponse = ThreadStartResponse
export type ThreadForkResponse = ThreadStartResponse

export interface TurnSummary {
  id: string
  status: "inProgress" | "completed" | "failed" | "interrupted"
  error: {
    message?: string
  } | null
}

export interface TurnStartResponse {
  turn: TurnSummary
}

export interface ReviewStartParams {
  threadId: string
  target: CodexReviewTarget
  delivery?: "inline" | "detached" | null
}

export interface ReviewStartResponse {
  turn: TurnSummary
  reviewThreadId: string
}

export interface ConfigReadResponse {
  config: Record<string, unknown>
  layers: unknown[] | null
}

export interface HooksListResponse {
  data: Array<{
    cwd: string
    hooks: Array<Record<string, unknown>>
    warnings: string[]
    errors: unknown[]
  }>
}

export interface SkillsListResponse {
  data: Array<{
    cwd: string
    skills: Array<{
      name: string
      description: string
      path: string
      scope: string
      enabled: boolean
    }>
    errors: unknown[]
  }>
}

export interface McpServerStatusListResponse {
  data: Array<{
    name: string
    authStatus: string
    tools: Record<string, unknown>
    resources: unknown[]
  }>
  nextCursor: string | null
}

export interface PluginListResponse {
  marketplaces: Array<{
    name: string
    path: string | null
    interface: { displayName?: string | null } | null
    plugins: Array<{
      id: string
      name: string
      version: string | null
      installed: boolean
      enabled: boolean
      availability: string
      interface: { shortDescription?: string | null } | null
    }>
  }>
  marketplaceLoadErrors: unknown[]
}

export interface ThreadStartedNotification {
  thread: ThreadSummary
}

export interface ThreadGoalUpdatedNotification {
  threadId: string
  turnId: string | null
  goal: ThreadGoal
}

export interface ThreadGoalClearedNotification {
  threadId: string
}

export interface TurnStartedNotification {
  threadId: string
  turn: TurnSummary
}

export interface TurnCompletedNotification {
  threadId: string
  turn: TurnSummary
}

export interface TurnPlanStep {
  step: string
  status: "pending" | "inProgress" | "completed"
}

export interface TurnPlanUpdatedNotification {
  threadId: string
  turnId: string
  explanation: string | null
  plan: TurnPlanStep[]
}

export interface PlanDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface ContextCompactedNotification {
  threadId: string
  turnId: string
}

export interface TokenUsageCounter {
  input_tokens?: number
  inputTokens?: number
  cached_input_tokens?: number
  cachedInputTokens?: number
  output_tokens?: number
  outputTokens?: number
  reasoning_output_tokens?: number
  reasoningOutputTokens?: number
  total_tokens?: number
  totalTokens?: number
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string
  turnId: string
  tokenUsage: {
    total_token_usage?: TokenUsageCounter
    total?: TokenUsageCounter
    last_token_usage?: TokenUsageCounter
    last?: TokenUsageCounter
    model_context_window?: number
    modelContextWindow?: number
  }
}

export interface ToolRequestUserInputOption {
  label: string
  description?: string | null
}

export interface ToolRequestUserInputQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: ToolRequestUserInputOption[] | null
}

export interface ToolRequestUserInputParams {
  threadId: string
  turnId: string
  itemId: string
  questions: ToolRequestUserInputQuestion[]
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>
}

export interface CommandExecutionRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  approvalId?: string | null
  reason?: string | null
  command?: string | null
  cwd?: string | null
}

export interface CommandExecutionOutputDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface AgentMessageDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export interface ReasoningSummaryTextDeltaNotification {
  threadId: string
  turnId: string
  itemId: string
  delta: string
  summaryIndex: number
}

export interface McpToolCallProgressNotification {
  threadId: string
  turnId: string
  itemId: string
  message: string
}

export interface WarningNotification {
  threadId: string | null
  message: string
}

export interface RawResponseItemCompletedNotification {
  threadId: string
  turnId: string
  item: {
    type: string
    call_id?: string
    output?: string
  } & Record<string, unknown>
}

export interface FileChangeRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string | null
  grantRoot?: string | null
}

export type CommandExecutionApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"

export type FileChangeApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"

export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision
}

export interface FileChangeRequestApprovalResponse {
  decision: FileChangeApprovalDecision
}

export interface ToolRequestUserInputRequest {
  id: CodexRequestId
  method: "item/tool/requestUserInput"
  params: ToolRequestUserInputParams
}

export interface DynamicToolCallParams {
  threadId: string
  turnId: string
  callId: string
  tool: string
  arguments: Record<string, unknown> | unknown[] | string | number | boolean | null
}

export interface DynamicToolCallOutputContentItem {
  type: "inputText" | "inputImage"
  text?: string
  imageUrl?: string
}

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[]
  success: boolean
}

export interface DynamicToolCallRequest {
  id: CodexRequestId
  method: "item/tool/call"
  params: DynamicToolCallParams
}

export interface CommandExecutionRequestApprovalRequest {
  id: CodexRequestId
  method: "item/commandExecution/requestApproval"
  params: CommandExecutionRequestApprovalParams
}

export interface FileChangeRequestApprovalRequest {
  id: CodexRequestId
  method: "item/fileChange/requestApproval"
  params: FileChangeRequestApprovalParams
}

export interface McpServerElicitationRequestParams {
  threadId: string
  turnId: string | null
  serverName: string
  mode: "form" | "openai/form" | "url"
  message: string
  requestedSchema?: {
    properties?: Record<string, {
      type?: string
      title?: string
      description?: string
      enum?: unknown[]
    }>
    required?: string[]
  }
  url?: string
  elicitationId?: string
}

export interface McpServerElicitationRequest {
  id: CodexRequestId
  method: "mcpServer/elicitation/request"
  params: McpServerElicitationRequestParams
}

export interface PermissionsRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  cwd: string
  reason: string | null
  permissions: {
    network: { enabled: boolean | null } | null
    fileSystem: Record<string, unknown> | null
  }
}

export interface PermissionsRequestApprovalRequest {
  id: CodexRequestId
  method: "item/permissions/requestApproval"
  params: PermissionsRequestApprovalParams
}

export type ServerRequest =
  | ToolRequestUserInputRequest
  | DynamicToolCallRequest
  | CommandExecutionRequestApprovalRequest
  | FileChangeRequestApprovalRequest
  | McpServerElicitationRequest
  | PermissionsRequestApprovalRequest

export interface UserMessageItem {
  type: "userMessage"
  id: string
  content: Array<{
    type: "text"
    text: string
    text_elements: []
  }>
}

export interface ReasoningItem {
  type: "reasoning"
  id: string
  summary: unknown[]
  content: unknown[]
}

export interface AgentMessageItem {
  type: "agentMessage"
  id: string
  text: string
  phase?: string
}

export interface PlanItem {
  type: "plan"
  id: string
  text: string
}

export interface CommandExecutionItem {
  type: "commandExecution"
  id: string
  command: string
  cwd?: string
  processId?: string
  status: "inProgress" | "completed" | "failed" | "declined"
  aggregatedOutput?: string | null
  exitCode?: number | null
  durationMs?: number | null
}

export interface McpToolCallItem {
  type: "mcpToolCall"
  id: string
  server: string
  tool: string
  arguments?: Record<string, unknown> | null
  result?: {
    content?: unknown[]
    structuredContent?: unknown
  } | null
  error?: {
    message?: string
  } | null
  status: "inProgress" | "completed" | "failed"
}

export interface DynamicToolCallItem {
  type: "dynamicToolCall"
  id: string
  tool: string
  arguments?: Record<string, unknown> | unknown[] | string | number | boolean | null
  status: "inProgress" | "completed" | "failed"
  contentItems?: DynamicToolCallOutputContentItem[] | null
  success?: boolean | null
  durationMs?: number | null
}

export interface CollabAgentToolCallItem {
  type: "collabAgentToolCall"
  id: string
  tool: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent"
  status: "inProgress" | "completed" | "failed"
  senderThreadId: string
  receiverThreadIds: string[]
  prompt?: string | null
  agentsStates?: Record<string, { status: string; message: string | null }> | null
}

export interface WebSearchItem {
  type: "webSearch"
  id: string
  query: string
  action?: {
    type?: string
    query?: string
    queries?: string[]
  } | null
}

export interface FileChangeItem {
  type: "fileChange"
  id: string
  changes: Array<{
    path: string
    kind:
      | "add"
      | "delete"
      | "update"
      | {
          type: "add" | "delete" | "update"
          move_path?: string | null
        }
    diff?: string | null
  }>
  status: "inProgress" | "completed" | "failed" | "declined"
}

export interface ErrorItem {
  type: "error"
  id: string
  message: string
}

export type ThreadItem =
  | UserMessageItem
  | ReasoningItem
  | AgentMessageItem
  | PlanItem
  | CommandExecutionItem
  | McpToolCallItem
  | DynamicToolCallItem
  | CollabAgentToolCallItem
  | WebSearchItem
  | FileChangeItem
  | ErrorItem

export interface ItemStartedNotification {
  item: ThreadItem
  threadId: string
  turnId: string
}

export interface ItemCompletedNotification {
  item: ThreadItem
  threadId: string
  turnId: string
}

export interface ErrorNotification {
  error: {
    message: string
    codexErrorInfo?: string
    additionalDetails?: unknown
  }
  willRetry: boolean
  threadId?: string
  turnId?: string
}

export interface TurnDiffUpdatedNotification {
  threadId: string
  turnId: string
  diff: string
}

export interface FileChangePatchUpdatedNotification {
  threadId: string
  turnId: string
  itemId: string
  changes: FileChangeItem["changes"]
}

export type ServerNotification =
  | { method: "thread/started"; params: ThreadStartedNotification }
  | { method: "thread/goal/updated"; params: ThreadGoalUpdatedNotification }
  | { method: "thread/goal/cleared"; params: ThreadGoalClearedNotification }
  | { method: "thread/tokenUsage/updated"; params: ThreadTokenUsageUpdatedNotification }
  | { method: "turn/started"; params: TurnStartedNotification }
  | { method: "turn/completed"; params: TurnCompletedNotification }
  | { method: "turn/plan/updated"; params: TurnPlanUpdatedNotification }
  | { method: "turn/diff/updated"; params: TurnDiffUpdatedNotification }
  | { method: "item/started"; params: ItemStartedNotification }
  | { method: "item/completed"; params: ItemCompletedNotification }
  | { method: "item/commandExecution/outputDelta"; params: CommandExecutionOutputDeltaNotification }
  | { method: "item/agentMessage/delta"; params: AgentMessageDeltaNotification }
  | { method: "item/reasoning/summaryTextDelta"; params: ReasoningSummaryTextDeltaNotification }
  | { method: "item/mcpToolCall/progress"; params: McpToolCallProgressNotification }
  | { method: "item/fileChange/patchUpdated"; params: FileChangePatchUpdatedNotification }
  | { method: "item/plan/delta"; params: PlanDeltaNotification }
  | { method: "rawResponseItem/completed"; params: RawResponseItemCompletedNotification }
  | { method: "thread/compacted"; params: ContextCompactedNotification }
  | { method: "error"; params: ErrorNotification }
  | { method: "warning"; params: WarningNotification }

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return Boolean(value) && typeof value === "object" && "id" in (value as Record<string, unknown>)
    && ("result" in (value as Record<string, unknown>) || "error" in (value as Record<string, unknown>))
    && !("method" in (value as Record<string, unknown>))
}

export function isServerRequest(value: unknown): value is ServerRequest {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.method !== "string" || !("id" in candidate)) return false
  return candidate.method === "item/tool/requestUserInput"
    || candidate.method === "item/tool/call"
    || candidate.method === "item/commandExecution/requestApproval"
    || candidate.method === "item/fileChange/requestApproval"
    || candidate.method === "mcpServer/elicitation/request"
    || candidate.method === "item/permissions/requestApproval"
}

export function isServerNotification(value: unknown): value is ServerNotification {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.method !== "string" || "id" in candidate) return false
  return candidate.method === "thread/started"
    || candidate.method === "thread/goal/updated"
    || candidate.method === "thread/goal/cleared"
    || candidate.method === "thread/tokenUsage/updated"
    || candidate.method === "turn/started"
    || candidate.method === "turn/completed"
    || candidate.method === "turn/plan/updated"
    || candidate.method === "turn/diff/updated"
    || candidate.method === "item/started"
    || candidate.method === "item/completed"
    || candidate.method === "item/commandExecution/outputDelta"
    || candidate.method === "item/agentMessage/delta"
    || candidate.method === "item/reasoning/summaryTextDelta"
    || candidate.method === "item/mcpToolCall/progress"
    || candidate.method === "item/fileChange/patchUpdated"
    || candidate.method === "item/plan/delta"
    || candidate.method === "rawResponseItem/completed"
    || candidate.method === "thread/compacted"
    || candidate.method === "error"
    || candidate.method === "warning"
}

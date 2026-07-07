import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Loader2, Pause, Pencil, Play, RefreshCw, Save, Square, Target, X } from "lucide-react"
import type { AgentProvider, CodexGoal, CodexGoalStatus } from "../../../shared/types"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip"
import { cn } from "../../lib/utils"

const GOAL_STATUS_LABELS: Record<CodexGoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
  complete: "Complete",
}

function GoalIconButton(props: {
  label: string
  children: ReactNode
  disabled?: boolean
  className?: string
  onClick: () => void
}) {
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={props.label}
          disabled={props.disabled}
          onClick={props.onClick}
          className={cn("h-7 w-7 rounded-md", props.className)}
        >
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  )
}

export function ChatGoalPanel({
  activeProvider,
  goal,
  isLoading,
  isSaving,
  disabled,
  onRefresh,
  onSave,
  onClear,
}: {
  activeProvider: AgentProvider | null
  goal: CodexGoal | null
  isLoading: boolean
  isSaving: boolean
  disabled: boolean
  onRefresh: () => Promise<CodexGoal | null>
  onSave: (objective: string, status?: CodexGoalStatus | null) => Promise<CodexGoal | null>
  onClear: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draftObjective, setDraftObjective] = useState("")

  useEffect(() => {
    if (editing) return
    setDraftObjective(goal?.objective ?? "")
  }, [editing, goal?.objective])

  const status = goal?.status ?? "active"
  const statusLabel = GOAL_STATUS_LABELS[status]
  const canSave = draftObjective.trim().length > 0 && !disabled && !isSaving
  const visible = activeProvider === "codex"

  const statusClassName = useMemo(() => {
    if (!goal) return "border-border text-muted-foreground"
    if (goal.status === "active") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    if (goal.status === "paused") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    if (goal.status === "complete") return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
    return "border-border bg-muted text-foreground"
  }, [goal])

  if (!visible) return null

  const saveDraft = async () => {
    if (!canSave) return
    const nextStatus = goal?.status ?? "active"
    await onSave(draftObjective.trim(), nextStatus)
    setEditing(false)
  }

  const pauseOrResume = async () => {
    if (!goal || disabled || isSaving) return
    await onSave(goal.objective, goal.status === "paused" ? "active" : "paused")
  }

  return (
    <div className="pointer-events-none absolute left-3 right-3 top-[52px] z-20">
      <div className="pointer-events-auto mx-auto flex min-h-[44px] max-w-[800px] items-center gap-2 rounded-lg border border-border/80 bg-background/95 px-2.5 py-2 shadow-sm backdrop-blur">
        <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={cn("shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium", statusClassName)}>
            {isLoading ? "Loading" : goal ? statusLabel : "No goal"}
          </span>
          {editing ? (
            <Input
              value={draftObjective}
              onChange={(event) => setDraftObjective(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void saveDraft()
                } else if (event.key === "Escape") {
                  setEditing(false)
                  setDraftObjective(goal?.objective ?? "")
                }
              }}
              placeholder="Set a goal"
              disabled={disabled || isSaving}
              className="h-8 min-w-0 flex-1 rounded-md py-1"
            />
          ) : (
            <div className="min-w-0 flex-1 truncate text-sm text-foreground">
              {goal?.objective ?? "Set a goal for this Codex thread"}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isLoading || isSaving ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          {editing ? (
            <>
              <GoalIconButton label="Save goal" disabled={!canSave} onClick={() => void saveDraft()}>
                <Save className="h-3.5 w-3.5" />
              </GoalIconButton>
              <GoalIconButton
                label="Cancel"
                disabled={isSaving}
                onClick={() => {
                  setEditing(false)
                  setDraftObjective(goal?.objective ?? "")
                }}
              >
                <X className="h-3.5 w-3.5" />
              </GoalIconButton>
            </>
          ) : (
            <>
              <GoalIconButton label="Refresh goal" disabled={disabled || isLoading || isSaving} onClick={() => void onRefresh()}>
                <RefreshCw className="h-3.5 w-3.5" />
              </GoalIconButton>
              <GoalIconButton label={goal ? "Edit goal" : "Create goal"} disabled={disabled || isSaving} onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </GoalIconButton>
              {goal ? (
                <GoalIconButton
                  label={goal.status === "paused" ? "Resume goal" : "Pause goal"}
                  disabled={disabled || isSaving}
                  onClick={() => void pauseOrResume()}
                >
                  {goal.status === "paused" ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                </GoalIconButton>
              ) : null}
              {goal ? (
                <GoalIconButton label="Stop goal" disabled={disabled || isSaving} onClick={() => void onClear()}>
                  <Square className="h-3.5 w-3.5" />
                </GoalIconButton>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

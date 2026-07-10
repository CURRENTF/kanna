import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { QueuedChatMessage } from "../../../shared/types"
import { Button } from "../ui/button"
import { createMarkdownComponents } from "./shared"
import { ArrowDown, ArrowUp, Check, Pencil, X } from "lucide-react"
import { useState } from "react"

interface QueuedUserMessageProps {
  message: QueuedChatMessage
  onRemove: () => void
  onSendNow: () => void
  onEdit?: (content: string) => Promise<void>
  onMoveUp?: () => void
  onMoveDown?: () => void
}

export function QueuedUserMessage({ message, onRemove, onSendNow, onEdit, onMoveUp, onMoveDown }: QueuedUserMessageProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!onEdit || saving) return
    setSaving(true)
    try {
      await onEdit(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex justify-end py-2">
      <div className="flex max-w-[85%] sm:max-w-[80%] flex-col items-end gap-1.5">
        {message.attachments.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-2">
            {message.attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="max-w-[220px] rounded-xl border border-dashed border-border bg-transparent px-3 py-2 text-left"
              >
                <div className="truncate text-[13px] font-medium text-foreground">{attachment.displayName}</div>
                <div className="truncate text-[11px] text-muted-foreground">{attachment.mimeType}</div>
              </div>
            ))}
          </div>
        ) : null}
        {message.content ? (
          <div className="relative group">

              <div className="grid grid-cols-[1fr_auto] items-end gap-2.5 rounded-[20px] border border-dashed border-border bg-transparent pl-3.5 pr-1.5 py-1.5 prose prose-sm prose-invert text-left text-primary [&_p]:whitespace-pre-line">
                <div>
                  {editing ? (
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      className="min-h-20 w-full resize-y bg-transparent text-sm outline-none"
                      aria-label="Edit queued message"
                    />
                  ) : (
                    <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>{message.content}</Markdown>
                  )}
                </div>
                  <Button
                  type="button"
                  variant="default"
                  size="none"
                  className="rounded-full size-[24px] bg-muted text-muted-foreground border border-primary/10 group-hover:!text-primary hover:bg-muted/60"
                  onClick={editing ? () => void save() : onSendNow}
                  disabled={saving}
                  aria-label={editing ? "Save queued message" : "Send queued message now"}
                >
                  {editing ? <Check className="size-3.5" /> : <ArrowUp className="size-3.5"/>}
                </Button>

              
            </div>
            <Button
              type="button"
              variant="none"
              size="none"
              className="opacity-0 scale-[0.1] group-hover:scale-[1.0] group-hover:opacity-100 !p-0.5 border rounded-full text-xs font-medium text-muted-foreground hover:text-foreground gap-0.5 absolute top-0 left-0 bg-background -translate-x-[28%] -translate-y-[28%]"
              onClick={onRemove}
              aria-label="Remove queued message"
            >
              <X className="size-3"/>
            </Button>

            <div className="absolute -top-7 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
              {onEdit ? (
                <Button type="button" variant="outline" size="icon" className="size-6 rounded-full" onClick={() => {
                  setDraft(message.content)
                  setEditing((value) => !value)
                }} aria-label="Edit queued message">
                  <Pencil className="size-3" />
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="icon" className="size-6 rounded-full" onClick={onMoveUp} disabled={!onMoveUp} aria-label="Move queued message up">
                <ArrowUp className="size-3" />
              </Button>
              <Button type="button" variant="outline" size="icon" className="size-6 rounded-full" onClick={onMoveDown} disabled={!onMoveDown} aria-label="Move queued message down">
                <ArrowDown className="size-3" />
              </Button>
            </div>

            {/* <Button
              type="button"
              variant="none"
              size="none"
              className="!p-1 border rounded-full text-xs font-medium text-muted-foreground hover:text-foreground gap-0.5 absolute top-0 right-0 bg-background translate-x-[30%] -translate-y-[30%]"
              onClick={onSendNow}
            >
              <ArrowUp className="size-3"/>
            </Button> */}
          </div>
          
        ) : null}

      </div>
    </div>
  )
}

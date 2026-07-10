import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { createMarkdownComponents } from "./shared"

export function ReasoningSummaryMessage({ message }: {
  message: Extract<HydratedTranscriptMessage, { kind: "reasoning_summary" }>
}) {
  return (
    <details className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium">Reasoning</summary>
      <div className="mt-2 prose prose-sm max-w-none text-muted-foreground">
        <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>{message.text}</Markdown>
      </div>
    </details>
  )
}

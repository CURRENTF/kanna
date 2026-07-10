import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ProcessedTextMessage } from "./types"
import { createMarkdownComponents } from "./shared"
import { FileCode2 } from "lucide-react"

interface Props {
  message: ProcessedTextMessage
}

export interface CodeReviewFinding {
  title: string
  body: string
  file: string
  start?: number
  end?: number
  priority?: number
}

function decodeDirectiveValue(value: string) {
  return value.replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
}

export function parseCodeReviewFindings(text: string) {
  const findings: CodeReviewFinding[] = []
  const markdown = text.replace(/::code-comment\{((?:\\.|[^}])*)\}/g, (_directive, attributes: string) => {
    const values: Record<string, string> = {}
    for (const match of attributes.matchAll(/([a-zA-Z][\w-]*)="((?:\\.|[^"])*)"/g)) {
      values[match[1]!] = decodeDirectiveValue(match[2] ?? "")
    }
    if (values.title && values.body && values.file) {
      const start = Number(values.start)
      const end = Number(values.end)
      const priority = Number(values.priority)
      findings.push({
        title: values.title,
        body: values.body,
        file: values.file,
        ...(Number.isFinite(start) && start > 0 ? { start } : {}),
        ...(Number.isFinite(end) && end > 0 ? { end } : {}),
        ...(Number.isFinite(priority) ? { priority } : {}),
      })
      return ""
    }
    return _directive
  }).trim()
  return { markdown, findings }
}

export function TextMessage({ message }: Props) {
  const { markdown, findings } = parseCodeReviewFindings(message.text)
  return (
    // <VerticalLineContainer className="w-full">
      <div className="text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-full space-y-4">
        {markdown ? <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>{markdown}</Markdown> : null}
        {findings.length > 0 ? (
          <div className="not-prose space-y-2" aria-label="Code review findings">
            {findings.map((finding, index) => (
              <article key={`${finding.file}:${finding.start ?? 0}:${index}`} className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <FileCode2 className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>{finding.title}</span>
                  </div>
                  {finding.priority !== undefined ? (
                    <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">P{finding.priority}</span>
                  ) : null}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{finding.body}</p>
                <code className="mt-2 block truncate text-xs text-muted-foreground">
                  {finding.file}{finding.start ? `:${finding.start}${finding.end && finding.end !== finding.start ? `-${finding.end}` : ""}` : ""}
                </code>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    // </VerticalLineContainer>
  )
}

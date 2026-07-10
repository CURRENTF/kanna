import type { HydratedTranscriptMessage } from "../../../shared/types"

type TurnDiff = Extract<HydratedTranscriptMessage, { kind: "turn_diff" }>

export function TurnDiffMessage({ message }: { message: TurnDiff }) {
  const fileCount = new Set(
    message.diff.split("\n")
      .filter((line) => line.startsWith("+++ b/"))
      .map((line) => line.slice(6)),
  ).size

  return (
    <details className="rounded-xl border border-border bg-muted/20 px-3 py-2 text-sm">
      <summary className="cursor-pointer select-none font-medium text-muted-foreground">
        Live turn diff{fileCount ? ` · ${fileCount} ${fileCount === 1 ? "file" : "files"}` : ""}
      </summary>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs text-foreground">{message.diff}</pre>
    </details>
  )
}

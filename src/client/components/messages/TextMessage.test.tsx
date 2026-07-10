import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { parseCodeReviewFindings, TextMessage } from "./TextMessage"

describe("TextMessage code review findings", () => {
  test("extracts code-comment directives and renders line-aware cards", () => {
    const text = 'Summary\n\n::code-comment{title="[P1] Race" body="This can race." file="/repo/a.ts" start="12" end="14" priority="1"}'
    expect(parseCodeReviewFindings(text)).toEqual({
      markdown: "Summary",
      findings: [{
        title: "[P1] Race",
        body: "This can race.",
        file: "/repo/a.ts",
        start: 12,
        end: 14,
        priority: 1,
      }],
    })

    const html = renderToStaticMarkup(<TextMessage message={{
      kind: "assistant_text",
      text,
      id: "review-1",
      timestamp: new Date(0).toISOString(),
    }} />)
    expect(html).toContain("Code review findings")
    expect(html).toContain("/repo/a.ts:12-14")
  })
})

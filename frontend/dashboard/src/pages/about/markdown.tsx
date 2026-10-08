import type { ReactNode } from "react"

type ParsedBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "divider" }

const HEADING_RE = /^(#{1,3})\s+(.*)$/
const DIVIDER_RE = /^-{3,}$/
const BULLET_ITEM_RE = /^[-*]\s+(.*)$/
const ORDERED_ITEM_RE = /^\d+\.\s+(.*)$/
// Deliberately "https://" only -- see renderInline below.
const INLINE_RE = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g

function parseBlock(chunk: string): ParsedBlock {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 1) {
    const headingMatch = HEADING_RE.exec(lines[0])
    if (headingMatch) return { type: "heading", level: headingMatch[1].length as 1 | 2 | 3, text: headingMatch[2] }
    if (DIVIDER_RE.test(lines[0])) return { type: "divider" }
  }
  if (lines.length > 0 && lines.every((line) => BULLET_ITEM_RE.test(line))) {
    return { type: "list", ordered: false, items: lines.map((line) => BULLET_ITEM_RE.exec(line)![1]) }
  }
  if (lines.length > 0 && lines.every((line) => ORDERED_ITEM_RE.test(line))) {
    return { type: "list", ordered: true, items: lines.map((line) => ORDERED_ITEM_RE.exec(line)![1]) }
  }
  return { type: "paragraph", text: lines.join(" ") }
}

function parseBlocks(markdown: string): ParsedBlock[] {
  return markdown
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map(parseBlock)
}

/** Inline spans within one block's text -- "**bold**" and a "https://" link
 * only. Anything else (a non-https link target, a bare "[label]" with no
 * "(url)", any other syntax) is left as literal text, rendered as a plain
 * React string child -- never dangerouslySetInnerHTML, so an HTML- or
 * script-looking substring is always inert, never parsed or executed. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let index = 0
  INLINE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    if (match[1] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${index++}`}>{match[1]}</strong>)
    } else {
      nodes.push(
        <a key={`${keyPrefix}-${index++}`} href={match[3]} target="_blank" rel="noopener noreferrer">
          {match[2]}
        </a>,
      )
    }
    lastIndex = INLINE_RE.lastIndex
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function renderBlock(block: ParsedBlock, key: string): ReactNode {
  if (block.type === "heading") {
    const content = renderInline(block.text, key)
    if (block.level === 1) return <h1 key={key}>{content}</h1>
    if (block.level === 3) return <h3 key={key}>{content}</h3>
    return <h2 key={key}>{content}</h2>
  }
  if (block.type === "divider") return <hr key={key} className="about-content__divider" />
  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul"
    return (
      <ListTag key={key}>
        {block.items.map((item, itemIndex) => (
          <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
        ))}
      </ListTag>
    )
  }
  return <p key={key}>{renderInline(block.text, key)}</p>
}

/** Safe, dependency-free Markdown rendering for backend-supplied content
 * (src/content/about/*.md, served via GET /about-content). Supports
 * exactly: headings (#/##/###), paragraphs, **bold**, bullet/ordered
 * lists, a horizontal rule (---), and "https://" links -- standard
 * Markdown constructs, not a custom block/style schema. The backend picks
 * which of these a page uses; this is the one place that decides what CSS
 * each one renders with (about.css). An unrecognized construct (a table,
 * an image, a raw HTML tag, a non-https link) falls through to the
 * plain-text path instead of crashing or being interpreted as markup. */
export function renderMarkdown(markdown: string): ReactNode[] {
  return parseBlocks(markdown).map((block, index) => renderBlock(block, `block-${index}`))
}

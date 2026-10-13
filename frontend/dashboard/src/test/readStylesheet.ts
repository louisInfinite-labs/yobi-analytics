/** Test helper: the real stylesheet text (comments stripped), read from disk -- vitest does not process CSS, and the frontend has no Node types,
 * so the fs module is imported dynamically. `rulesOf` splits it into flat { selector, body } pairs (nested @media rules are included flat). */
export async function readStylesheet(relativeToDashboard: string): Promise<string> {
  const fs = await import(/* @vite-ignore */ ["node", "fs"].join(":"))
  const { process } = globalThis as unknown as { process: { cwd(): string } }
  return String(fs.readFileSync(`${process.cwd()}/${relativeToDashboard}`, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "")
}

export function rulesOf(css: string): { selector: string; body: string }[] {
  return Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => ({ selector: match[1].trim(), body: match[2] }))
}

/** The body of the first rule whose selector list contains exactly `selector`. */
export function ruleBody(css: string, selector: string): string {
  const rule = rulesOf(css).find((entry) => entry.selector.split(",").some((part) => part.trim() === selector))
  if (!rule) throw new Error(`no rule for ${selector}`)
  return rule.body
}

/** The text of every block `@media <query> { ... }` (balanced braces), concatenated. */
export function mediaBlocks(css: string, query: string): string {
  const out: string[] = []
  let from = 0
  for (;;) {
    const start = css.indexOf(`@media ${query}`, from)
    if (start === -1) break
    const open = css.indexOf("{", start)
    let depth = 1
    let i = open + 1
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth += 1
      else if (css[i] === "}") depth -= 1
      i += 1
    }
    out.push(css.slice(open + 1, i - 1))
    from = i
  }
  return out.join("\n")
}

/** Everything outside every @media block. */
export function outsideMedia(css: string): string {
  let result = css
  for (;;) {
    const start = result.indexOf("@media")
    if (start === -1) return result
    const open = result.indexOf("{", start)
    let depth = 1
    let i = open + 1
    while (depth > 0 && i < result.length) {
      if (result[i] === "{") depth += 1
      else if (result[i] === "}") depth -= 1
      i += 1
    }
    result = result.slice(0, start) + result.slice(i)
  }
}

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

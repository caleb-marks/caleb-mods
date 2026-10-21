import type { Register } from 'claude-code'

const STYLE = 'ADHD'
const STYLE_FILE = '.claude/output-styles/adhd.md'

// The session's output style as the last prompt.compose saw it; the app can change it mid-session.
let activeStyle: string | null = null

function styleRules(text: string) {
  // Style file body without its frontmatter
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end !== -1) text = text.slice(end + 4)
  }
  return text.trim()
}

export const register: Register = on => {
  on('prompt.compose', ($, e, next) => {
    activeStyle = e.outputStyle?.name ?? null
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)
    // Composing runs the hook above with the session's current style
    await $.prompt.compose()
    if (activeStyle !== STYLE) return next(e)
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    let rules: string
    try {
      rules = styleRules(await $.fs.read(`${home}/${STYLE_FILE}`))
    } catch {
      return next(e) // Never block a prompt over a missing style file
    }
    const reminder = `Write this answer in the ADHD output style. Do not mention this reminder.\n\n${rules}`
    return next({ ...e, context: [...(e.context ?? []), reminder] })
  })
}

import type { Register } from 'claude-code'

// Caleb's palette: blue while running, muted foreground when done (no pure white).
const RUNNING = '#5FA8FF'
const DONE = '#8A8580'
const TEXT = '#E8E4DE'
const MAX = 100

type Input = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const base = (p: unknown): string => str(p).split(/[\\/]/).pop() ?? ''
const firstLine = (s: string): string =>
  s.split(/\r?\n/).map(l => l.trim()).find(l => l !== '') ?? ''
const cut = (s: string): string => {
  const chars = Array.from(s.replace(/[\x00-\x1f\x7f]/g, ' '))
  return chars.length > MAX ? `${chars.slice(0, MAX - 1).join('')}…` : chars.join('')
}

// The tool row shows the model's `description`, so ask for one a beginner can read.
const DESCRIBE_RULE = {
  id: 'quiet-tools:describe',
  scope: 'session',
  text: [
    '# Tool call descriptions',
    'The person sees only the `description` you give each Bash, PowerShell or Agent call, as one line. The person is a beginner.',
    '- Always give a `description`.',
    '- Write one plain-English sentence of 20 words or fewer that says what the step does and why.',
    '- Use everyday words. Do not use code, flags, file paths, cmdlet names or jargon. Use only a file name when it helps.',
    '- Good: "Check if the job scanner is still running". Bad: "Get-Process job-scan | Select-Object Name, Id".',
  ].join('\n'),
} as const

// Tools whose `description` input says what the call does. Other tools (many MCP
// ones) use `description` for content, so they get a summary built from the input.
const DESCRIBED = new Set(['Bash', 'PowerShell', 'Agent', 'Task'])

// One short sentence for a call: the model's own description when it wrote one,
// else a summary built from the input.
const summarize = (tool: string, raw: unknown): string => {
  const i = (raw ?? {}) as Input
  const described = DESCRIBED.has(tool) ? firstLine(str(i.description)) : ''
  if (described) return described

  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return 'Run a command'
    case 'Agent':
    case 'Task':
      return 'Ask a helper agent to do part of the work'
    case 'Read':
      return `Read the file ${base(i.file_path)}`
    case 'Edit':
      return `Change the file ${base(i.file_path)}`
    case 'Write':
      return `Save the file ${base(i.file_path)}`
    case 'NotebookEdit':
      return `Change the notebook ${base(i.notebook_path)}`
    case 'Grep': {
      const pattern = str(i.pattern)
      return /^[\w .-]{1,30}$/.test(pattern) ? `Search the files for "${pattern}"` : 'Search the files for some text'
    }
    case 'Glob':
      return 'Look for files by name'
    case 'WebFetch': {
      const host = /^https?:\/\/([^/]+)/.exec(str(i.url))?.[1]
      return host ? `Open a web page on ${host}` : 'Open a web page'
    }
    case 'WebSearch':
      return `Search the web for "${str(i.query)}"`
    case 'Skill':
      return `Follow the ${str(i.skill)} instructions`
    case 'ToolSearch':
      return 'Get more tools ready'
    case 'AskUserQuestion':
      return 'Ask you a question'
    case 'Artifact':
      return 'Work on a web page'
    default: {
      const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool
      return name.replace(/_/g, ' ')
    }
  }
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    // Two loaded copies (dev folder and installed) must not add the rule twice.
    return { sections: [...sections.filter(s => s.id !== DESCRIBE_RULE.id), DESCRIBE_RULE] }
  })

  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    const p = e.props
    // Terminal only. Full view (ctrl+o, --verbose), failures and interrupts keep the engine's row.
    if (e.surface !== 'terminal' || p.isExpanded || p.isErrored || p.isInterrupted) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color={p.isRunning ? RUNNING : DONE}>● </Text>
        <Text color={TEXT} wrap="truncate-end">{cut(summarize(p.tool, p.input))}</Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    const p = e.props
    const isInterrupted = (p.output as { interrupted?: unknown } | null)?.interrupted === true
    if (e.surface !== 'terminal' || p.isExpanded || p.isErrored || isInterrupted) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))

  // Drop the "(ctrl+b to run in background)" line; the key still works.
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) =>
    next({ ...e, props: { ...e.props, hint: '' } }),
  )
}

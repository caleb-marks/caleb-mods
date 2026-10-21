import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Busy, Suggestion } from '../types'

const MODEL = 'claude-opus-5-5'

const isBusy = atom({ plugin: 'prompt-optimizer', key: 'isBusy' } as const, false as Busy)
const suggestion = atom(
  { plugin: 'prompt-optimizer', key: 'suggestion' } as const,
  { status: 'none' } as Suggestion,
)

const MAX_NEXT_WORDS = 19

const NEXT_RULES = `You write the user's next prompt in a chat with an AI coding agent.
Read the user's last prompt and the agent's answer. Pick the one action the user most likely takes next, first match wins:
1. The answer asks a question or offers a choice: answer it, picking the agent's recommended option.
2. The answer names a next step: ask for that step.
3. The answer changed something it did not check: ask to test it where it runs.
4. Otherwise: ask for the next step toward the goal of the last prompt.
Rules:
- 15 words or fewer, one line, an imperative the user sends as is.
- Never state a result, observation, or fact the user has not said.
- Name the exact file, command, function, or item from the answer; never only "it" or "this".
- No placeholders, quotes, greetings, or "please".
- Output only the prompt.`

const RULES = `You rewrite a prompt draft so another AI agent gets the real outcome the writer wants, not only the task they named.

Before you write, think silently about what a top professional in this field would make true here that the writer did not ask for. Use it to raise the bar inside the writer's scope. Do not widen the scope.

Output exactly one paragraph that starts with "Goal: " and describes the outcome: what is true for the user when the work is done. Output plain text with nothing before or after it (no code fence, no other sections, no notes, no questions).

Goal rules:
- Exactly one goal. Fold every part of the draft into one end result for the user.
- 1-2 sentences, 50 words or fewer in all. Each sentence is outcome-first (the subject is the user or the finished thing), specific, measurable, and atomic.
- Name no method (audit, refactor, review). Limits are fine.
- Keep every standard, book, framework, file, path, name, and number the draft mentions.
- Give a time frame or end point when the draft has one.
- Replace every vague word with an exact value: "about 30 miles" becomes "within 30 miles", "good" or "easy" becomes what the user does and how fast or how often.
- Make every claim checkable: "complete" or "current" names the source of truth it is checked against (for example "every job posted on careers.example.com today").
- Resolve contradictions: when two parts can conflict (a location filter and remote roles), state which one wins.
- Cut every clause that only restates the outcome or explains why it helps ("so the user can...", "letting the user...", "within one scan").
- Positive framing. No "think carefully" or "double-check".

When a fact is missing, choose the most likely value and keep going. Never ask questions.`

// The prompt that started the main loop's current turn, and the id of the newest suggestion request.
let lastPrompt = ''
let suggestRun = 0
// Suggestion calls this module instance has running; a reload starts a new instance with none.
let callsInFlight = 0

async function isDesktop($: EngineInterface) {
  return (await $.session.surfaces()).includes('desktop')
}

async function suggestNext($: EngineInterface, prompt: string, answer: string) {
  const run = ++suggestRun
  // Counted until the state leaves 'thinking', so a redraw in between does not start a second call
  callsInFlight++
  try {
    await update($, suggestion, (): Suggestion => ({ status: 'thinking', prompt, answer }))
    const r = await $.model.complete({
      model: MODEL,
      effort: 'medium',
      system: [{ text: NEXT_RULES, cache: true }],
      prompt: `<last_prompt>\n${prompt.slice(-800)}\n</last_prompt>\n\n<answer>\n${answer.slice(-2500)}\n</answer>`,
      // Room for thinking at medium effort; the reply itself is cut to MAX_NEXT_WORDS
      maxTokens: 1024,
      timeoutMs: 30000,
    })
    if (run !== suggestRun) return
    const text = r.isAnswered ? r.text.trim().replace(/^["'`]+|["'`]+$/g, '').split('\n')[0]!.trim() : ''
    const words = text.split(/\s+/).filter(Boolean)
    // NONE, or a prompt over the limit, offers nothing: a cut-off prompt reads as a broken one
    if (words.length === 0 || words.length > MAX_NEXT_WORDS || text === 'NONE') {
      await update($, suggestion, (): Suggestion => ({ status: 'none' }))
      return
    }
    await update($, suggestion, (): Suggestion => ({ status: 'ready', text: words.join(' ') }))
  } finally {
    callsInFlight--
  }
}

async function useSuggestion($: EngineInterface) {
  const now = await read($, suggestion)
  if (now.status !== 'ready') return
  suggestRun++
  await update($, suggestion, () => ({ status: 'none' }))
  // One click sends it in the desktop app, whose box a mod cannot write; elsewhere it goes in the box to edit
  if (await isDesktop($)) await $.prompt.submit({ text: now.text })
  else await $.prompt.fill({ text: now.text })
}

async function dismissSuggestion($: EngineInterface) {
  suggestRun++
  await update($, suggestion, () => ({ status: 'none' }))
}

// The draft before the last rewrite, and the rewrite itself, so a second press undoes it.
let original: string | null = null
let rewritten: string | null = null

const MAX_GOAL_WORDS = 50
// Words that leave a Goal unmeasurable; one found sends the Goal back once for an exact value.
const VAGUE =
  /\b(about|around|roughly|approximately|near|nearby|modern|good|better|nice|easy|easily|quick|quickly|fast|faster|soon|cheap|some|several|few|various|etc|kinda|pretty|or so)\b|\w+-ish\b/gi

function goalProblems(goal: string): string[] {
  const problems: string[] = []
  const words = goal.split(/\s+/).filter(Boolean).length
  if (words > MAX_GOAL_WORDS) problems.push(`It has ${words} words; the limit is ${MAX_GOAL_WORDS}.`)
  const vague = [...new Set((goal.match(VAGUE) ?? []).map(w => w.toLowerCase()))]
  if (vague.length > 0) problems.push(`It uses vague words: ${vague.map(w => `"${w}"`).join(', ')}. Replace each with an exact value or cut it.`)
  return problems
}

function cleanGoal(text: string): string {
  return text.trim().replace(/^```\w*\n?|\n?```$/g, '').trim()
}

async function optimize($: EngineInterface, draft: string): Promise<string | null> {
  await update($, isBusy, () => true)
  $.ui.status('Optimizing prompt...')
  try {
    const ask = async (prompt: string) =>
      $.model.complete({
        model: MODEL,
        effort: 'medium',
        system: [{ text: RULES, cache: true }],
        prompt,
        maxTokens: 2048,
        timeoutMs: 60000,
      })
    const first = `Rewrite this prompt draft:\n\n<draft>\n${draft}\n</draft>`
    const r = await ask(first)
    if (!r.isAnswered) {
      $.ui.toast(`Prompt optimizer failed: ${r.reason}`)
      return null
    }
    const goal = cleanGoal(r.text)
    const problems = goalProblems(goal)
    if (problems.length === 0) return goal

    // One retry: shorten and make exact. Keep the first Goal if the retry fails.
    const retry = await ask(
      `${first}\n\nYour Goal was:\n\n<goal>\n${goal}\n</goal>\n\n${problems.join(' ')} Rewrite the Goal to fix this. Keep every name, number, and source.`,
    )
    return retry.isAnswered ? cleanGoal(retry.text) : goal
  } finally {
    $.ui.status(undefined)
    await update($, isBusy, () => false)
  }
}

async function press($: EngineInterface) {
  if (await read($, isBusy)) return
  const { text } = await $.prompt.read()
  const draft = text.trim()

  if (rewritten !== null && original !== null && draft === rewritten.trim()) {
    await $.prompt.fill({ text: original })
    rewritten = null
    $.ui.toast('Original prompt restored')
    return
  }
  if (draft === '') {
    $.ui.toast('Type a prompt first, then click Optimize prompt')
    return
  }

  const better = await optimize($, draft)
  if (better === null) return
  const { isFilled } = await $.prompt.fill({ text: better })
  if (!isFilled) {
    $.ui.toast('Could not write to the prompt box')
    return
  }
  original = text
  rewritten = better
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload drops a suggestion call in flight; start it again from what it was written from.
    const left = await read($, suggestion)
    if (left.status === 'thinking') {
      void suggestNext($, left.prompt, left.answer)
    }
    await $.command.register({
      name: 'optimize',
      description: 'Rewrite a prompt with Opus 5.5 and put it in the prompt box',
      argumentHint: '<prompt draft>',
    })
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) lastPrompt = e.text
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await dismissSuggestion($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && e.answer.trim() !== '') {
      // Not awaited: the suggestion fills the band later and never holds up the turn.
      void suggestNext($, lastPrompt, e.answer)
    }
    return done
  })

  on('command.run', { command: 'optimize' }, async ($, e) => {
    const draft = e.args.trim()
    if (draft === '') return { text: 'Usage: /optimize <prompt draft>. Or type the draft and click Optimize prompt.' }
    const better = await optimize($, draft)
    if (better === null) return { text: 'Prompt optimizer failed.' }
    await $.prompt.fill({ text: better })
    original = draft
    rewritten = better
    return { text: 'Optimized prompt is in the prompt box. Click Optimize prompt to restore the original.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const busy = await read($, isBusy)
    const next_ = await read($, suggestion)
    if (next_.status === 'thinking' && callsInFlight === 0) {
      // A reload dropped the call that was writing this suggestion; start it again.
      void suggestNext($, next_.prompt, next_.answer)
    }

    return (
      <Box flexDirection="column">
        {next_.status === 'thinking' && <Text dimColor>Next prompt: thinking...</Text>}
        {next_.status === 'ready' && (
          <Box flexDirection="row" gap={1}>
            <Button key="use-suggestion" variant="primary" onPress={() => useSuggestion($)}>
              {next_.text}
            </Button>
            <Button key="dismiss-suggestion" label="x" plain dimColor onPress={() => dismissSuggestion($)} />
          </Box>
        )}
        <Button
          key="optimize"
          label={busy ? 'Optimizing prompt...' : 'Optimize prompt'}
          plain
          dimColor
          onPress={() => press($)}
        />
      </Box>
    )
  })
}

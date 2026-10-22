import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Busy, Suggestion } from '../types'

const MODEL = 'claude-opus-5-5'
// Writes the first suggestion guess while Opus works
const FAST_MODEL = 'claude-haiku-5-5'
// The conversation the suggester and the optimizer read, from its end
const CONVERSATION_CHARS = 12000
// Saved (answer end, next prompt) pairs: how many to keep, and how many to show the model
const HABITS_KEY = 'habits'
const MAX_HABITS = 40
const HABIT_EXAMPLES = 10

const isBusy = atom({ plugin: 'prompt-optimizer', key: 'isBusy' } as const, false as Busy)
const suggestion = atom(
  { plugin: 'prompt-optimizer', key: 'suggestion' } as const,
  { status: 'none' } as Suggestion,
)

const MAX_NEXT_WORDS = 20
const MAX_SUGGESTIONS = 3

const NEXT_RULES = `You write the user's next prompt in a chat with an AI coding agent.
Read the workspace, the user's recent prompts, and the agent's last answer. Write up to ${MAX_SUGGESTIONS} different prompts the user is likely to send next, most likely first, one per line:
1. The answer asks a question or offers a choice: answer it; the first line picks the agent's recommended option, another line picks the alternative.
2. The answer names a next step: ask for that step.
3. The answer changed something it did not check: ask to test it where it runs.
4. Otherwise: ask for the next step toward the goal of the recent prompts.
Rules for each line:
- Write it the way this user writes next prompts in the examples: their words, their length, and the kind of step they take after an answer like this one.
- ${MAX_NEXT_WORDS} words or fewer, an imperative the user sends as is, with no edits.
- Stay on the task of the workspace and the recent prompts; never start an unrelated task.
- Never state a result, observation, or fact the user has not said.
- Name the exact file, command, function, or item; never only "it" or "this".
- No numbering, bullets, placeholders, quotes, greetings, or "please".
Output only the lines. Fewer lines are better than a weak one.`

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

Intent rules:
- Read the context first: the workspace, the writer's recent prompts, and the agent's last answer. Find what the draft points at ("this", "that", "it", "the bug", "those 2") and what the writer is trying to finish.
- Name those things exactly in the Goal: the file, feature, item, or number from the context.
- Aim the Goal at the result the writer needs next in that work, not at a general reading of the draft.
- Use the context only to sharpen the draft; never add a task the draft does not ask for. Same length as without context.

When a fact is missing, choose the most likely value and keep going. Never ask questions.`

// The main loop's recent prompts, newest last, and the id of the newest suggestion request.
const recentPrompts: string[] = []
// The main loop's last answer, so the optimizer knows what a draft points at
let lastAnswer = ''
let suggestRun = 0
// Suggestion calls this module instance has running; a reload starts a new instance with none.
let callsInFlight = 0

async function isDesktop($: EngineInterface) {
  return (await $.session.surfaces()).includes('desktop')
}

// Lines of the model's reply that can be sent as is: no list marks or quotes, 1 to MAX_NEXT_WORDS words, no repeats
export function parseSuggestions(reply: string): string[] {
  const lines = reply
    .split('\n')
    .map(l => l.trim().replace(/^(\d+[.)]|[-*•])\s+/, '').replace(/^["'`]+|["'`]+$/g, '').trim())
    .filter(l => l !== '' && l !== 'NONE')
    .filter(l => l.split(/\s+/).length <= MAX_NEXT_WORDS)
  return [...new Set(lines)].slice(0, MAX_SUGGESTIONS)
}

// A reply the agent would write, not a prompt the user would send: the fast model sometimes answers instead
export function soundsLikeAgent(reply: string) {
  return /^\s*(I|I'm|I'll|I've|Sure|Here|Okay|OK)\b|\?\s*$/m.test(reply)
}

async function workspace($: EngineInterface) {
  const cwd = await $.session.cwd().catch(() => '')
  const repo = await $.session.repo().catch(() => null)
  return [cwd && `Folder: ${cwd}`, repo && `Repository: ${JSON.stringify(repo)}`].filter(Boolean).join('\n')
}

// The conversation so far, oldest first, cut to its last CONVERSATION_CHARS; falls back to the recent prompts
async function conversation($: EngineInterface) {
  const rows = await $.session.messages().catch(() => [])
  const text = rows
    .filter(m => m.text.trim() !== '')
    .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.text.trim().slice(0, 3000)}`)
    .join('\n\n')
  return text !== '' ? text.slice(-CONVERSATION_CHARS) : recentPrompts.map(p => `User: ${p}`).join('\n\n')
}

// Pairs of (end of the agent's answer, the prompt the user sent next), kept on this computer across sessions
type HabitPair = { after: string; next: string }

async function habits($: EngineInterface): Promise<HabitPair[]> {
  const saved = await $.store.get(HABITS_KEY).catch(() => undefined)
  return Array.isArray(saved) ? (saved as HabitPair[]) : []
}

async function learnHabit($: EngineInterface, next: string) {
  if (lastAnswer.trim() === '' || next.trim() === '') return
  const pairs = [...(await habits($)), { after: lastAnswer.slice(-400), next: next.slice(0, 300) }]
  await $.store.set(HABITS_KEY, pairs.slice(-MAX_HABITS)).catch(() => {})
}

function habitExamples(pairs: HabitPair[]) {
  return pairs
    .slice(-HABIT_EXAMPLES)
    .map(p => `<example>\n<answer_end>${p.after}</answer_end>\n<user_sent>${p.next}</user_sent>\n</example>`)
    .join('\n')
}

// Everything a suggestion is written from: workspace, the user's habits, the conversation, and the last answer
async function suggestContext($: EngineInterface, answer: string) {
  return [
    `<workspace>\n${await workspace($)}\n</workspace>`,
    `<how_this_user_writes_next_prompts>\n${habitExamples(await habits($))}\n</how_this_user_writes_next_prompts>`,
    `<conversation>\n${await conversation($)}\n</conversation>`,
    `<answer>\n${answer.slice(-2500)}\n</answer>`,
    `You are not the agent and you do not answer the user. Write the prompts the user sends the agent next: up to ${MAX_SUGGESTIONS} lines in the user's voice. Output only those lines.`,
  ].join('\n\n')
}

async function suggestNext($: EngineInterface, answer: string) {
  const run = ++suggestRun
  // Counted until the state leaves 'thinking', so a redraw in between does not start a second call
  callsInFlight++
  let isFinal = false
  const ask = (model: string, effort: 'low' | 'medium', context: string) =>
    $.model.complete({
      model,
      effort,
      system: [{ text: NEXT_RULES, cache: true }],
      prompt: context,
      // Room for thinking; the lines themselves are short
      maxTokens: 1024,
      timeoutMs: 30000,
    })
  try {
    await update($, suggestion, (): Suggestion => ({ status: 'thinking', prompt: '', answer }))
    const context = await suggestContext($, answer)
    // A fast first guess shows in seconds; Opus replaces it when it is done
    const fast = ask(FAST_MODEL, 'low', context).then(async r => {
      const texts = r.isAnswered && !soundsLikeAgent(r.text) ? parseSuggestions(r.text) : []
      if (run === suggestRun && !isFinal && texts.length > 0) {
        await update($, suggestion, (): Suggestion => ({ status: 'ready', texts }))
      }
    })
    const r = await ask(MODEL, 'medium', context)
    isFinal = true
    if (run !== suggestRun) return
    // A line over the limit is dropped, not cut: a cut-off prompt reads as a broken one
    const texts = r.isAnswered ? parseSuggestions(r.text) : []
    if (texts.length > 0) await update($, suggestion, (): Suggestion => ({ status: 'ready', texts }))
    else {
      // Opus gave nothing usable; keep the fast guess when it has one
      await fast.catch(() => {})
      const now = await read($, suggestion)
      if (now.status !== 'ready') await update($, suggestion, (): Suggestion => ({ status: 'none' }))
    }
  } finally {
    callsInFlight--
  }
}

async function useSuggestion($: EngineInterface, index: number) {
  const now = await read($, suggestion)
  if (now.status !== 'ready') return
  const text = now.texts[index]
  if (text === undefined) return
  suggestRun++
  await update($, suggestion, () => ({ status: 'none' }))
  if (!(await isDesktop($))) {
    await $.prompt.fill({ text })
    return
  }
  // The desktop box takes no text from a mod, and a prompt a mod sends carries a "plugin sent" label,
  // so the click copies it: Ctrl+V and Enter send it as the user's own
  if ((await $.ui.copy({ text, surface: 'desktop' })).isCopied) $.ui.toast('Copied. Press Ctrl+V, then Enter.')
  else await $.prompt.submit({ text })
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
    const context = `<workspace>\n${await workspace($)}\n</workspace>\n\n<conversation>\n${await conversation($)}\n</conversation>`
    const first = `${context}\n\nRewrite this prompt draft:\n\n<draft>\n${draft}\n</draft>`
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
      void suggestNext($, left.answer)
    }
    await $.command.register({
      name: 'optimize',
      description: 'Rewrite a prompt with Opus 5.5 and put it in the prompt box',
      argumentHint: '<prompt draft>',
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await learnHabit($, e.text)
      recentPrompts.push(e.text.slice(-600))
      if (recentPrompts.length > 3) recentPrompts.shift()
    }
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
      lastAnswer = e.answer
      void suggestNext($, e.answer)
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

    return (
      <Box flexDirection="column">
        {next_.status === 'thinking' && <Text dimColor>Next prompt: thinking...</Text>}
        {next_.status === 'ready' && (
          <Box flexDirection="row" gap={1}>
            <Box flexDirection="column">
              {next_.texts.map((text, i) => (
                <Button key={`use-suggestion-${i}`} variant={i === 0 ? 'primary' : undefined} onPress={() => useSuggestion($, i)}>
                  {text}
                </Button>
              ))}
            </Box>
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

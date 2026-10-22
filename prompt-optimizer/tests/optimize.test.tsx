import { expect, test } from 'claude-code/testing'
import { parseSuggestions, soundsLikeAgent } from '../hooks/register'

const BAND = {
  plugin: 'prompt-optimizer',
  component: 'AbovePrompt',
  props: { hasSurvey: false },
} as const

test('the button rewrites the draft with Opus 5.5, and a second press restores it', async ($, on) => {
  let draft = 'fix my app'
  const asks: { model: string; effort?: string }[] = []

  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('model.complete', (_, e) => {
    asks.push({ model: e.model, effort: e.effort })
    return { value: { isAnswered: true, text: '```\nGoal: A user finishes checkout with no help.\n```', usage: {} } }
  })
  on('prompt.fill', (_, e) => {
    draft = e.text
    return { isFilled: true, text: e.text }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    draft = 'fix my app'
    const ui = await $.ui.mount({ ...BAND, surface })

    await ui.press({ key: 'optimize' })
    expect(draft).toBe('Goal: A user finishes checkout with no help.')

    await ui.press({ key: 'optimize' })
    expect(draft).toBe('fix my app')
    await ui.unmount()
  }

  expect(asks[0]).toEqual({ model: 'claude-opus-5-5', effort: 'medium' })
})

// A click copies the suggestion, so it sends as the user's own; when the copy fails, the mod sends it
const desktopClick = (isCopied: boolean) => async ($: any, on: any) => {
  const sent: string[] = []
  const copied: string[] = []
  let answerModel: () => void = () => {}
  const asked = new Promise<void>(done => (answerModel = done))

  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', (_: any, e: any) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.copy', (_: any, e: any) => {
    copied.push(e.text)
    return { value: isCopied ? { isCopied: true } : { isCopied: false, reason: 'no clipboard' } }
  })
  on('model.complete', async () => {
    await asked
    return { value: { isAnswered: true, text: 'Run the parser tests.', usage: {} } }
  })

  await $.turn.start({ text: 'add a parser', turnId: 't1' })
  await $.turn.complete({ answer: 'I added the parser.', turnId: 't1', reason: 'answer', durationMs: 5, isAborted: false })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  answerModel()
  await ui.settle?.()
  expect((await ui.find({ key: 'use-suggestion-0' }))?.text).toBe('Run the parser tests.')

  await ui.press({ key: 'use-suggestion-0' })
  expect(copied).toEqual(['Run the parser tests.'])
  expect(sent).toEqual(isCopied ? [] : ['Run the parser tests.'])
  expect(await ui.find({ key: 'use-suggestion-0' })).toBeUndefined()
  await ui.unmount()
}

test('in the desktop app, one click copies the next prompt to paste and send', desktopClick(true))

test('in the desktop app, when the copy fails, one click sends the next prompt', desktopClick(false))

test('NONE offers no next prompt', async ($, on) => {
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', () => ({ value: { isAnswered: true, text: 'NONE', usage: {} } }))

  await $.turn.start({ text: 'check the box', turnId: 't1' })
  await $.turn.complete({ answer: 'Tell me what you see.', turnId: 't1', reason: 'answer', durationMs: 5, isAborted: false })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.settle?.()
  expect(await ui.find({ key: 'use-suggestion-0' })).toBeUndefined()
  await ui.unmount()
})

test('in the terminal, one click on the band puts the next prompt in the box to edit', async ($, on) => {
  let draft = ''
  let answerModel: () => void = () => {}
  const asked = new Promise<void>(done => (answerModel = done))
  const asks: { model: string; prompt: string; effort?: string }[] = []

  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('model.complete', async (_, e) => {
    asks.push({ model: e.model, prompt: e.prompt, effort: e.effort })
    await asked
    return { value: { isAnswered: true, text: '"Run the tests and fix any failures in the parser."', usage: {} } }
  })
  on('prompt.fill', (_, e) => {
    draft = e.text
    return { isFilled: true, text: e.text }
  })

  await $.turn.start({ text: 'add a parser', turnId: 't1' })
  // The turn ends while the model is still writing the suggestion.
  await $.turn.complete({ answer: 'I added the parser.', turnId: 't1', reason: 'answer', durationMs: 5, isAborted: false })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /thinking/ }))?.text).toBe('Next prompt: thinking...')

  answerModel()
  await ui.settle?.()
  const offer = await ui.find({ key: 'use-suggestion-0' })
  expect(offer?.text).toBe('Run the tests and fix any failures in the parser.')
  // A fast first guess, then Opus at medium effort, both from the conversation
  expect(asks.map(a => [a.model, a.effort])).toEqual([['claude-haiku-5-5', 'low'], ['claude-opus-5-5', 'medium']])
  expect(asks[1]?.prompt).toContain('add a parser')

  await ui.press({ key: 'use-suggestion-0' })
  expect(draft).toBe('Run the tests and fix any failures in the parser.')
  expect(await ui.find({ key: 'use-suggestion-0' })).toBeUndefined()
  await ui.unmount()
})

test('a suggestion over 19 words is dropped, not cut off', async ($, on) => {
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
  let answerModel: () => void = () => {}
  const asked = new Promise<void>(done => (answerModel = done))

  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('model.complete', async () => {
    await asked
    return { value: { isAnswered: true, text: long, usage: {} } }
  })

  await $.turn.start({ text: 'add a parser', turnId: 't1' })
  await $.turn.complete({ answer: 'I added the parser.', turnId: 't1', reason: 'answer', durationMs: 5, isAborted: false })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  answerModel()
  await ui.settle?.()
  const offer = await ui.find({ key: 'use-suggestion-0' })
  expect(offer).toBeUndefined()
  await ui.unmount()
})

test('a Goal over 50 words or with vague words goes back once to be shortened and made exact', async ($, on) => {
  let draft = 'find me a cheap car around here'
  const asks: string[] = []
  const long = `Goal: ${'The user gets a list of good cars around Austin. '.repeat(6)}`
  const exact = 'Goal: The user gets 5 used cars under $15,000 within 25 miles of Austin, TX.'

  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('model.complete', (_, e) => {
    asks.push(e.prompt)
    return { value: { isAnswered: true, text: asks.length === 1 ? long : exact, usage: {} } }
  })
  on('prompt.fill', (_, e) => {
    draft = e.text
    return { isFilled: true, text: e.text }
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'optimize' })

  expect(asks.length).toBe(2)
  expect(asks[1]).toContain('words; the limit is 50')
  expect(asks[1]).toContain('"good"')
  expect(asks[1]).toContain('"around"')
  expect(draft).toBe(exact)
  await ui.unmount()
})

test('a short exact Goal is kept with no retry', async ($, on) => {
  let draft = 'list example co jobs'
  let calls = 0
  const exact = 'Goal: The user gets every Example Co job on careers.example.com today within 30 miles of Austin, TX.'

  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('model.complete', () => {
    calls++
    return { value: { isAnswered: true, text: exact, usage: {} } }
  })
  on('prompt.fill', (_, e) => {
    draft = e.text
    return { isFilled: true, text: e.text }
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'optimize' })

  expect(calls).toBe(1)
  expect(draft).toBe(exact)
  await ui.unmount()
})

test('a reply with list marks and quotes gives up to 3 clean prompts, and drops lines over 20 words', async () => {

  const long = Array.from({ length: 21 }, (_, i) => `w${i}`).join(' ')
  expect(parseSuggestions(`1. "Run the parser tests."\n- Commit the parser\n${long}\n* Run the parser tests.\n- Push main\n- Open a PR`)).toEqual([
    'Run the parser tests.',
    'Commit the parser',
    'Push main',
  ])
})

test('a reply in the agent voice is not offered as a fast guess', () => {
  expect(soundsLikeAgent("I can't tell whether the suggester works from here.")).toBe(true)
  expect(soundsLikeAgent('Should I push the changes?')).toBe(true)
  expect(soundsLikeAgent('Push the suggester changes to caleb-marks/caleb-mods\nRun /reload-plugins')).toBe(false)
})

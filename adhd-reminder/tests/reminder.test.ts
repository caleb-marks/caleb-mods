import { expect, test } from 'claude-code/testing'

test('with no output style, the prompt enters unchanged', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))

  const r = await $.prompt.submit({ text: 'hi' })
  expect(r.text).toBe('hi')
  expect(r.context).toBeUndefined()
})

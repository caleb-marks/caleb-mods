export type Busy = boolean

// The next prompt offered after a turn: being written (with what it is written from, so a reload can restart it), ready, or none.
export type Suggestion =
  | { status: 'none' }
  | { status: 'thinking'; prompt: string; answer: string }
  | { status: 'ready'; texts: string[] }

declare module 'claude-code' {
  interface PluginState {
    'prompt-optimizer': { isBusy: Busy; suggestion: Suggestion }
  }
}

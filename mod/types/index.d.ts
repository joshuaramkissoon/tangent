// The doc open in the pane: its path, its text, and the blocks that changed in the last edit.
export type Doc = { path: string; text: string; changed: string[] }

// A note in the margin: what was selected, what kind of answer was asked for, and the answer
// (null while it is on its way). A note made from text inside another note's answer has a parent.
export type Note = {
  id: string
  quote: string
  kind: 'explain' | 'ask' | 'deeper'
  question?: string
  answer: string | null
  error?: string
  parent?: string
  // Which model answered, and how long it took.
  via?: string
  ms?: number
}

export type Sel = { text: string; requestId?: string }

// What the pane hands the doc's Client region (hooks/doc.tsx).
export type DocProps = { text: string; notes: Note[]; changed: string[]; columns: number }

declare module 'claude-code' {
  interface PluginState {
    tangent: {
      doc: Doc | null
      notes: Note[]
      sel: Sel | null
      dismissed: string | null
      written: string | null
      asking: boolean
    }
  }
}

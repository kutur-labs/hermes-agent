/**
 * MessageLine — renders one transcript row (spec v4 §2 / §7). An assistant turn
 * is ONE ordered `parts[]` dispatched by `<Switch>`/`<Match>` on `part.type`, so
 * text / reasoning / tool interleave INLINE (the §7 fix for "tools dump below").
 * User/system rows (and settled/resumed assistant rows with no parts) render flat
 * `text`. Fully themed; rich text via <b>/<span>, never an attributes bitmask (§8 #1).
 *
 * Stable `id` per part as the <For> key so a new tool part below a streaming text
 * part doesn't remount it. Native <markdown> for text parts lands in 2b-ii.
 */
import { For, Match, Show, Switch } from 'solid-js'

import type { Message } from '../logic/store.ts'
import { Markdown } from './markdown.tsx'
import { useTheme } from './theme.tsx'
import { ToolPart } from './toolPart.tsx'

const GUTTER = 2

export function MessageLine(props: { message: Message }) {
  const theme = useTheme()
  const m = () => props.message
  const glyph = () => (m().role === 'assistant' ? theme().brand.icon : m().role === 'user' ? theme().brand.prompt : '·')
  const glyphFg = () =>
    m().role === 'assistant' ? theme().color.accent : m().role === 'user' ? theme().color.prompt : theme().color.muted
  const hasParts = () => (m().parts?.length ?? 0) > 0

  return (
    <box style={{ flexDirection: 'row', flexShrink: 0, marginTop: m().role === 'user' ? 1 : 0 }}>
      <box style={{ flexShrink: 0, width: GUTTER }}>
        <text>
          <span style={{ fg: glyphFg() }}>{glyph()}</span>
        </text>
      </box>
      <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        <Show
          when={m().role === 'assistant' && hasParts()}
          fallback={
            // No parts yet: the just-started streaming turn shows ONLY the caret,
            // inline with the glyph (not an empty line + a dangling caret below —
            // item 10 cursor misalignment); a settled row shows its flat text.
            <Show
              when={m().streaming && !hasParts()}
              fallback={
                <text>
                  <span style={{ fg: theme().color.text }}>{m().text}</span>
                </text>
              }
            >
              <text>
                <span style={{ fg: theme().color.muted }}>▍</span>
              </text>
            </Show>
          }
        >
          <For each={m().parts ?? []}>
            {part => (
              <Switch>
                <Match when={part.type === 'tool' && part}>{tool => <ToolPart part={tool()} />}</Match>
                <Match when={part.type === 'reasoning' && part}>
                  {r => (
                    <text>
                      <span style={{ fg: theme().color.muted }}>{r().text}</span>
                    </text>
                  )}
                </Match>
                <Match when={part.type === 'text' && part}>
                  {t => <Markdown text={t().text} streaming={m().streaming ?? false} />}
                </Match>
              </Switch>
            )}
          </For>
        </Show>
      </box>
    </box>
  )
}

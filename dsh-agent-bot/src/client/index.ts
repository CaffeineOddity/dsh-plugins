/**
 * 智能体中枢 -- Client 半体：设置页入口。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: (spec: string) => any

interface ClientCtx {
  get(name: string): any
  effect(fn: () => (() => void) | void, label?: string): void
}

interface ReactHooks {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown
  Fragment: unknown
}

export const inject = ['slots']

interface PanelProps {
  close: () => void
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    const slots = ctx.get('slots') as
      | {
          inject(key: string, cb: () => () => void): () => void
          register(opts: Record<string, unknown>, render: (props: PanelProps) => unknown): () => void
        }
      | undefined
    if (!slots) return () => undefined
    return slots.inject('settings.section', () =>
      slots.register(
        {
          name: 'settings.section',
          id: 'agent-bot',
          order: 21,
          label: () => '智能体中枢',
          inject: () => ({}),
        },
        (props: PanelProps) => createEntry(props),
      ),
    )
  })
}

const { createElement: e, Fragment } = require('react') as ReactHooks

const buttonStyle = {
  padding: '8px 16px',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  background: 'var(--dsh-color-primary, #2563eb)',
  color: '#fff',
  fontFamily: 'inherit',
}

const muted = { color: 'var(--dsh-color-muted, #888)', fontSize: '13px' } as const

function createEntry({ close }: PanelProps): unknown {
  const openPage = () => {
    window.open('/agent-bot', '_blank')
    close()
  }
  return e(
    Fragment,
    null,
    e('h2', null, '智能体中枢'),
    e('p', muted, '管理 skills / prompts / agents。通道（飞书等）只做收发，在各自插件里绑定 agentId。'),
    e('p', muted, '会话里输 /agent <名字> <问题> 可直接调某 agent 回答。'),
    e('button', { style: buttonStyle, onClick: openPage }, '打开配置页'),
  )
}

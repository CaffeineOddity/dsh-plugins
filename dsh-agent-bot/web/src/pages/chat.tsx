import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@ui/components/ui/button'
import { Card, CardContent } from '@ui/components/ui/card'
import { NativeSelect } from '@ui/components/ui/native-select'
import { Textarea } from '@ui/components/ui/textarea'
import { rpc } from '../api'

type Agent = { id: string; name: string; description?: string }
type Msg = { role: 'user' | 'assistant'; text: string; err?: boolean }

function pageSession() {
  let id = localStorage.getItem('agentbot-chat-session')
  if (!id) {
    id = 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    localStorage.setItem('agentbot-chat-session', id)
  }
  return id
}

export function ChatPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState('')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void (async () => {
      const r = await rpc<Agent[]>('listAgents')
      if (!r.ok || !r.value) { toast.error(r.error || '加载失败'); return }
      const list = Array.isArray(r.value) ? r.value : []
      setAgents(list)
      const pre = new URLSearchParams(location.search).get('agent')
      setAgentId(pre && list.some((a) => a.id === pre) ? pre : list[0]?.id || '')
    })()
  }, [])

  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [messages])

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await rpc<{ messages?: { text?: string }[] }>('inbox', { sessionKey: pageSession() })
        const list = r.ok && r.value && Array.isArray(r.value.messages) ? r.value.messages : []
        if (list.length) setMessages((prev) => [...prev, ...list.filter((m) => m.text).map((m) => ({ role: 'assistant' as const, text: m.text || '' }))])
      } catch { /* 下一轮再试 */ }
    }, 4000)
    return () => clearInterval(id)
  }, [])

  async function send() {
    if (sending) return
    if (!agentId) { toast.error('请先选择智能体'); return }
    const body = text.trim()
    if (!body) return
    setSending(true)
    setText('')
    setMessages((prev) => [...prev, { role: 'user', text: body }])
    try {
      const r = await rpc<{ messages?: { text?: string }[] }>('ask', { agentId, context: body, sessionKey: pageSession() })
      if (!r.ok || !r.value) {
        setMessages((prev) => [...prev, { role: 'assistant', text: r.error || '请求失败', err: true }])
        return
      }
      const list = r.value.messages || []
      setMessages((prev) => [...prev, ...(list.length ? list.map((m) => ({ role: 'assistant' as const, text: m.text || '' })) : [{ role: 'assistant' as const, text: '本轮没有生成内容' }])])
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', text: err instanceof Error ? err.message : String(err), err: true }])
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="grid w-full gap-4">
      <h1 className="text-xl font-semibold">对话</h1>
      <Card>
        <CardContent className="grid gap-3 pt-6">
          <label className="text-sm font-medium" htmlFor="agent-select">智能体</label>
          <NativeSelect id="agent-select" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={!agents.length}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.description ? ' — ' + a.description : ''}</option>)}
          </NativeSelect>
          {!agents.length ? <p className="text-sm text-muted-foreground">先去 <a className="underline" href="/agent-bot/agents">Agents</a> 页建一个智能体。</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-3 pt-6">
          <div ref={box} className="flex max-h-[28rem] min-h-64 flex-col gap-3 overflow-auto rounded-md bg-muted/40 p-3" role="log">
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'ml-8 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground' : 'mr-8 rounded-lg border bg-card px-3 py-2 text-sm'}>
                <p className="mb-1 text-xs opacity-70">{m.role === 'user' ? '我' : m.err ? '错误' : '智能体'}</p>
                <p className="whitespace-pre-wrap">{m.text}</p>
              </div>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <Textarea value={text} placeholder="输入消息，回车发送（Shift+回车换行）" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} />
            <Button onClick={() => void send()} disabled={sending || !agents.length}>发送</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

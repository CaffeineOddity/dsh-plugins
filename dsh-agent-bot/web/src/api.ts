export type RpcResult<T = unknown> = { ok: boolean; error?: string; value?: T }

export async function rpc<T = unknown>(endpoint: string, payload: Record<string, unknown> = {}): Promise<RpcResult<T>> {
  const res = await fetch('/agent-bot-rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  if (!res.ok) return { ok: false, error: 'http ' + res.status }
  return (await res.json()) as RpcResult<T>
}

export type Provider = { id: string; label?: string }
export type Status = {
  providers?: Provider[]
  configDir?: string
  bootLogTail?: string
  askLogTail?: string
  scanLogTail?: string
}

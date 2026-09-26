import { pageKey, Shell } from './shell'
import { AgentsPage } from './pages/agents'
import { ChatPage } from './pages/chat'
import { LogPage } from './pages/log'
import { PromptsPage } from './pages/prompts'
import { SettingsPage } from './pages/settings'
import { SkillsPage } from './pages/skills'

export function App() {
  const key = pageKey()
  const page =
    key === 'prompts' ? <PromptsPage />
    : key === 'agents' ? <AgentsPage />
    : key === 'chat' ? <ChatPage />
    : key === 'settings' ? <SettingsPage />
    : key === 'log' ? <LogPage />
    : <SkillsPage />
  return <Shell>{page}</Shell>
}

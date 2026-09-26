import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const src = join(root, 'dist/index.html')
const destDir = join(root, '../src/view/config-site/assets')
for (const name of ['skills.html', 'prompts.html', 'agents.html', 'chat.html', 'settings.html', 'log.html']) {
  copyFileSync(src, join(destDir, name))
}

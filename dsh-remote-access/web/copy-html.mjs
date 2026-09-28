import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const destDir = join(root, '../plugins/assets')
mkdirSync(destDir, { recursive: true })
copyFileSync(join(root, 'dist/index.html'), join(destDir, 'index.html'))

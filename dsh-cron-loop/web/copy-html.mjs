import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
copyFileSync(join(root, 'dist/index.html'), join(root, '../plugins/assets/cron.html'))

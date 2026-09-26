import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPlugin, parseArgs, pluginTitle, REPO_ROOT, validatePluginName } from './create-plugin.mjs'

test('validatePluginName 拒绝非法名和保留名', () => {
  assert.equal(validatePluginName('dsh-notes'), null)
  assert.ok(validatePluginName(''))
  assert.ok(validatePluginName('Foo'))
  assert.ok(validatePluginName('a_b'))
  assert.ok(validatePluginName('-abc'))
  assert.ok(validatePluginName('a/b'))
  assert.ok(validatePluginName('ui'))
  assert.ok(validatePluginName('a'.repeat(65)))
})

test('pluginTitle 去掉 dsh- 前缀并分词', () => {
  assert.equal(pluginTitle('dsh-notes'), 'Notes')
  assert.equal(pluginTitle('my-tool'), 'My Tool')
})

test('parseArgs 识别 --no-install', () => {
  assert.equal(parseArgs(['--name', 'dsh-notes', '--no-install']).install, false)
  assert.throws(() => parseArgs(['--weird']), /未知参数/)
})

test('createPlugin 写出可被 run.sh 发布的脚手架', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-create-'))
  try {
    const dest = await createPlugin({ name: 'dsh-notes', root, install: false })
    const pkg = JSON.parse(await readFile(path.join(dest, 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'dsh-notes')
    assert.equal(pkg.version, '0.0.1')
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.ok(pkg.scripts.typecheck)
    assert.ok(pkg.scripts.build)
    const patch = await readFile(path.join(dest, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /id: dsh-notes/)
    assert.match(patch, /name: \.\/plugins\/web\.ts/)
    assert.deepEqual(patch.match(/\.\/plugins\/[^.]*\.ts/g), ['./plugins/web.ts'])
    const web = await readFile(path.join(dest, 'plugins/web.ts'), 'utf8')
    assert.match(web, /const ROUTE = '\/dsh-notes'/)
    assert.match(web, /const API_ROUTE = `\$\{ROUTE\}\/api`/)
    assert.match(web, /pathname !== `\$\{API_ROUTE\}\/health`/)
    const shell = await readFile(path.join(dest, 'web/src/shell.tsx'), 'utf8')
    assert.match(shell, /<aside/)
    assert.match(shell, /<main/)
    const files = [
      'package.json',
      'cordis.patch.yml',
      'plugins/web.ts',
      'web/src/app.tsx',
      'web/src/pages/overview.tsx',
      'web/src/pages/settings.tsx',
      'README.md',
      'README.en.md',
    ]
    for (const file of files) {
      const text = await readFile(path.join(dest, file), 'utf8')
      assert.equal(text.includes('__PLUGIN_'), false, file)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('目录已存在时不覆盖', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-create-'))
  try {
    await mkdir(path.join(root, 'dsh-notes'))
    await writeFile(path.join(root, 'dsh-notes/keep.txt'), 'stay')
    await assert.rejects(createPlugin({ name: 'dsh-notes', root, install: false }), /目录已存在/)
    assert.equal(await readFile(path.join(root, 'dsh-notes/keep.txt'), 'utf8'), 'stay')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('run.sh 帮助含 --create，且不破坏已有插件入口', () => {
  const help = spawnSync('bash', ['run.sh', '-h'], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--create/)

  const missing = spawnSync('bash', ['run.sh', '--create'], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /插件名/)

  const bad = spawnSync('bash', ['run.sh', '--create', 'Bad_Name'], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.notEqual(bad.status, 0)

  const existing = spawnSync('bash', ['run.sh', 'dsh-cron-loop'], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(existing.status, 0)
  assert.match(existing.stdout, /用法/)
  assert.doesNotMatch(existing.stdout, /已创建/)
})

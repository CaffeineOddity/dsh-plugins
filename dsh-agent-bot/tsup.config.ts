import { defineConfig } from 'tsup'

/**
 * 智能体中枢 DSH 插件构建：
 * - src/index.ts        → dist/index.js   （Host 半体，ESM）
 * - src/client/index.ts → dist/client.js  （Client 半体，闭包工厂）
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    // 配置站静态页：src/view/config-site/assets/* → dist/config-site/assets/，供 GET /agent-bot 前缀读取。
    publicDir: 'src/view',
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'],
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: ['cjs'],
    platform: 'browser',
    outDir: 'dist',
    clean: false,
    sourcemap: true,
    dts: false,
    outExtension() {
      return { js: '.js' }
    },
    external: [
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/cordis',
      'react',
      'react-dom',
    ],
    esbuildOptions(options) {
      options.banner = {
        js: 'window.__ModuleLoader__.load({ id: "@oddity/dsh-agent-bot", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
      }
      options.footer = {
        js: 'return module.exports; } });',
      }
    },
  },
])

#!/usr/bin/env node
// Install a stub for @deepseek-ai/dsh-tools so the plugin can be imported
// outside a running DSH. The real package is provided by the harness.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const here = import.meta.dirname
const dir = join(here, '..', 'node_modules', '@deepseek-ai', 'dsh-tools')
await mkdir(dir, { recursive: true })
await writeFile(join(dir, 'index.mjs'), 'export function defineTool(def) { return def }\n', 'utf8')
await writeFile(
  join(dir, 'package.json'),
  JSON.stringify(
    {
      name: '@deepseek-ai/dsh-tools',
      type: 'module',
      main: 'index.mjs',
      exports: { '.': './index.mjs' },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)
console.log('stub ready:', dir)

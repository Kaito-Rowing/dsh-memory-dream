#!/usr/bin/env node
// テスト用の defineTool スタブを node_modules に置く。
// DSH 本体が提供するパッケージなので、リポジトリにはコミットしない。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-tools')
await mkdir(dir, { recursive: true })
await writeFile(
  join(dir, 'index.mjs'),
  'export function defineTool(def) { return def }\n',
  'utf8',
)
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

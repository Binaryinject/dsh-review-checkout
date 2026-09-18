#!/usr/bin/env node
/**
 * Copy the built plugin files from this checkout into the profile dsh web actually
 * loads (…/.dsh/profiles/<profile>/node_modules/dsh-review-checkout).
 *
 * Why this exists: editing lib/*.js in the checkout changes NOTHING until the
 * profile copy is updated — the running host keeps its loaded module and the browser
 * keeps its bundle, so a fix can look "done" in the repo while the app still runs the
 * old code (that exact mistake cost a debugging round: the log kept showing the old
 * `spawnSync … ETIMEDOUT` long after the launcher had been rewritten).
 *
 * Usage: node scripts/sync-profile.mjs [profileName]   (default: web)
 */
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const profile = process.argv[2] || 'web'
const target = join(homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-review-checkout')

const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const files = ['lib/client.js', 'lib/index.js', 'package.json']

if (!existsSync(target)) {
  console.error(`profile copy not found: ${target}`)
  console.error('install the plugin into that profile first (dsh plugin install), or pass another profile name')
  process.exit(1)
}

let copied = 0
for (const rel of files) {
  const from = join(root, rel)
  const to = join(target, rel)
  if (!existsSync(from)) continue
  copyFileSync(from, to)
  const same = statSync(from).size === statSync(to).size
  console.log(`${same ? 'ok  ' : 'WARN'} ${rel} -> ${to} (${statSync(to).size} bytes)`)
  copied += 1
}

console.log(`\n${copied} file(s) copied into profile "${profile}".`)
console.log('Host-side changes (lib/index.js) need a dsh web RESTART; client-only changes need a page reload.')
console.log(`plugin: ${name}`)

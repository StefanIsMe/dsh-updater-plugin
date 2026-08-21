// DSH self-updater supervised restart helper. The HOST writes `arm.json` and
// `spawn.json` BEFORE spawning this file, then the host exits. This supervisor
// keeps a replacement DSH alive while the arm exists, clears the arm once the
// child has been alive for `clearAfterMs`, and writes `dead` after exhausting
// `maxAttempts`. Everything lands in `restart.log`.

import { readFileSync, writeFileSync, existsSync, rmSync, appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const stateDir = process.argv[2]
if (typeof stateDir !== 'string' || stateDir.length === 0) {
  process.exit(0)
}

const logPath = join(stateDir, 'restart.log')
function log (text) {
  try { appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`) } catch { /* best effort */ }
}

const armPath = join(stateDir, 'arm.json')
const spawnPath = join(stateDir, 'spawn.json')
if (!existsSync(armPath) || !existsSync(spawnPath)) {
  // Nothing armed, no directions: never start anything.
  process.exit(0)
}

let payload
try {
  payload = JSON.parse(readFileSync(spawnPath, 'utf8'))
} catch {
  log('supervisor: corrupt spawn.json; exiting')
  process.exit(0)
}

const cmd = Array.isArray(payload.cmd) && payload.cmd.length > 0 ? payload.cmd.map(String) : null
const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : process.cwd()
const clearAfterMs = typeof payload.clearAfterMs === 'number' ? payload.clearAfterMs : 20_000
const maxAttempts = Math.max(1, typeof payload.maxAttempts === 'number' ? payload.maxAttempts : 3)
const verifyUrl = typeof payload.verifyUrl === 'string' && payload.verifyUrl.length > 0 ? payload.verifyUrl : 'http://127.0.0.1:3080/'
const verifyMarker = typeof payload.verifyMarker === 'string' && payload.verifyMarker.length > 0 ? payload.verifyMarker : 'dsh-client-ui-updater'
if (cmd === null) {
  log('supervisor: no launch command; exiting')
  process.exit(0)
}

/** Prove the web UI actually serves: HTTP 200 + a mounted client plugin row + no boot error banner. */
async function verifyUi () {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(verifyUrl, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) {
      log(`supervisor: verify ${verifyUrl} -> HTTP ${res.status}`)
      return false
    }
    const body = await res.text()
    if (!body.includes(verifyMarker)) {
      log(`supervisor: verify failed — boot manifest missing marker ${verifyMarker}`)
      return false
    }
    if (body.includes('Failed to load plugins')) {
      log('supervisor: verify failed — "Failed to load plugins" banner present')
      return false
    }
    log(`supervisor: UI verified (${verifyMarker} present, no boot banner)`)
    return true
  } catch (error) {
    log(`supervisor: verify fetch failed: ${String(error)}`)
    return false
  }
}

function clearArm () {
  try { rmSync(armPath) } catch { /* best effort */ }
}
function markDead () {
  try { writeFileSync(join(stateDir, 'dead'), new Date().toISOString()) } catch { /* best effort */ }
}

let attempts = 0
function attempt () {
  attempts += 1
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
    windowsHide: true,
  })
  log(`supervisor: attempt ${attempts}/${maxAttempts}: ${cmd.join(' ')}`)
  child.on('error', (err) => {
    log(`supervisor: launch error: ${String(err)}`)
  })
  const timer = setTimeout(async () => {
    const ok = await verifyUi()
    if (ok) {
      clearArm()
      log(`supervisor: arm cleared after ${clearAfterMs} ms — child left running`)
    } else {
      log('supervisor: UI verification failed — killing child for retry')
      try { child.kill() } catch { /* best effort */ }
    }
  }, clearAfterMs)
  child.on('exit', () => {
    clearTimeout(timer)
    if (existsSync(armPath)) {
      if (attempts < maxAttempts) attempt()
      else markDead()
    } else {
      log('supervisor: arm absent — exiting')
    }
  })
}
attempt()
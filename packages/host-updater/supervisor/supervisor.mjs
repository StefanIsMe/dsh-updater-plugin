// Restart the configured DSH profile and publish completion only after its application check passes.
import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
const dir = process.argv[2]
if (!dir) process.exit(1)
const arm = join(dir, 'arm.json'), operationPath = join(dir, 'operation.json')
if (!existsSync(arm)) process.exit(0)
const spec = JSON.parse(readFileSync(join(dir, 'spawn.json'), 'utf8'))
const log = text => appendFileSync(join(dir, 'restart.log'), `${new Date().toISOString()} ${text}\n`)
const publish = (file, value) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2)+'\n'); renameSync(tmp, file) }
function record(ok, detail) {
  if (existsSync(operationPath)) {
    const op = JSON.parse(readFileSync(operationPath, 'utf8'))
    op.checks = op.checks.filter(c => c.name !== 'post-restart')
    op.checks.push({ name: 'post-restart', status: ok ? 'passed' : 'failed', detail })
    op.stage = ok ? 'complete' : 'restart'
    publish(operationPath, op)
  }
  if (ok) { if (existsSync(arm)) unlinkSync(arm); if (existsSync(join(dir,'dead'))) unlinkSync(join(dir,'dead')) }
  else writeFileSync(join(dir,'dead'), detail+'\n')
  log(detail)
}
if (!Array.isArray(spec.verifyCommand) || !spec.verifyCommand.length) { record(false, 'No application verification command configured'); process.exit(1) }
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
// The old host must release its resources before a replacement binds them.
for (let i=0; spec.parentPid && alive(spec.parentPid) && i<120; i++) await sleep(500)
if (spec.parentPid && alive(spec.parentPid)) { record(false, 'Previous host did not stop; no duplicate host launched'); process.exit(1) }
function check() {
  return new Promise(resolve => {
    const child = spawn(spec.verifyCommand[0], spec.verifyCommand.slice(1), {cwd:spec.cwd, windowsHide:true, stdio:'ignore'})
    let timedOut = false
    const timer = setTimeout(() => {timedOut=true; child.kill()}, 30000)
    child.once('error', () => {clearTimeout(timer); resolve(false)})
    child.once('close', code => {clearTimeout(timer); resolve(code===0 && !timedOut)})
  })
}
let verified=false
for (let attempt=1; attempt<=spec.maxAttempts; attempt++) {
  const child=spawn(spec.cmd[0], spec.cmd.slice(1), {cwd:spec.cwd, detached:true, windowsHide:true, stdio:'ignore'})
  let ended=false
  child.once('error', () => {ended=true})
  child.once('exit', () => {ended=true})
  log(`Launch attempt ${attempt}/${spec.maxAttempts}`)
  for (let i=0; i<24 && !ended; i++) {
    await sleep(5000)
    if (!ended && await check()) {record(true,'Restarted application passed verification'); verified=true; break}
  }
  child.unref()
  if (verified) break
  if (!ended) {record(false,'Application check failed; replacement left running for diagnosis, recovery data retained'); break}
  if (attempt===spec.maxAttempts) record(false,'Replacement exited before verification; launch attempts exhausted')
}
process.exitCode=verified?0:1

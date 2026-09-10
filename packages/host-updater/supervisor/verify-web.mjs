// Configurable authenticated web-profile verification. Secrets are read locally and never printed.
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
const root=process.cwd()
const config=JSON.parse(readFileSync(resolve(process.argv[2] ?? '.dsh/updater/verification.json'),'utf8'))
const auth=JSON.parse(readFileSync(resolve(config.authFile),'utf8'))
const loginUrl=new URL(auth.url)
if (loginUrl.origin!==new URL(config.url).origin) throw new Error('Authentication file does not match the configured application')
const login=await fetch(loginUrl,{redirect:'manual',signal:AbortSignal.timeout(10000)})
const cookie=login.headers.get('set-cookie')?.split(';',1)[0]
if(login.status!==303 || !cookie) throw new Error('Authenticated login failed')
const headers={cookie,'content-type':'application/json'}
const page=await fetch(config.url,{headers,signal:AbortSignal.timeout(10000)})
if(!page.ok || !(await page.text()).includes('__ModuleLoader__')) throw new Error('Authenticated application page did not load')
async function rpc(method,args=[]) {
 const rpcId=randomUUID()
 const res=await fetch(new URL('/api/'+method,config.url),{method:'POST',headers,body:JSON.stringify({type:'client-request',rpcId,method,payload:{args}}),signal:AbortSignal.timeout(30000)})
 if(!res.ok)throw new Error(method+' HTTP '+res.status)
 const body=await res.json()
 if(body.rpcId!==rpcId || !body.result?.ok)throw new Error(method+' failed: '+(body.result?.error?.code ?? 'invalid response'))
 return body.result.value
}
const status=await rpc('updater/status')
if(config.targetSha && status.currentSha!==config.currentSha) throw new Error('Running checkout differs from verified checkout')
if(status.conflictedFiles.length || status.error)throw new Error('Updater reports unresolved repairs')
const inventory=await rpc('pluginInventory/list')
const failed=inventory.entries.filter(e=>e.enabled&&e.fiberPhase==='failed')
if(failed.length)throw new Error('An enabled plugin failed to load')
const names=new Set(inventory.entries.filter(e=>e.enabled).map(e=>e.moduleName))
for(const name of config.expectedPlugins ?? [])if(!names.has(name))throw new Error('An expected plugin is missing: '+name)
const sessions=await rpc('session/list')
if(!Array.isArray(sessions))throw new Error('Session listing did not return records')
if(config.sessionId && !sessions.some(s=>s.sessionId===config.sessionId))throw new Error('The preserved session is missing')
console.log(`PASS authenticated page, updater, ${names.size} enabled plugins and ${sessions.length} saved sessions`)

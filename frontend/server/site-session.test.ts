import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('shared account bar rechecks identity and logs out with CSRF', async () => {
  const nodes: any[] = [], calls: any[] = [], navigations: string[] = []
  const events: Record<string, () => Promise<void>> = {}
  let authenticated = true
  const document = {hidden:false, getElementById:()=>null, createElement:()=>({style:{},setAttribute(){},append(...items:any[]){nodes.push(...items)}}), body:{append(){}}, addEventListener:(name:string,fn:any)=>events[name]=fn}
  const context = {document, location:{hostname:'roles.learnflow.club',pathname:'/projects/12',href:'https://roles.learnflow.club/projects/12',replace:(url:string)=>navigations.push(url),assign(){},reload(){}}, window:{addEventListener:(name:string,fn:any)=>events[name]=fn}, setInterval(){}, encodeURIComponent, URL, URLSearchParams,
    fetch: async (url:string, options:any) => {
      calls.push([url,options])
      return {ok:true, json:async()=>url.endsWith('/csrf')?{csrf_token:'bound-token'}:{authenticated,learner_id:2,display_name:'测试用户'}}
    }}
  vm.runInNewContext(readFileSync(resolve('public/site-session.js'),'utf8'),context)
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(nodes[1].textContent,'已登录 · 测试用户')
  await nodes[2].onclick()
  assert.equal(calls.at(-1)[0],'/api/auth/logout')
  assert.equal(calls.at(-1)[1].headers['X-CSRF-Token'],'bound-token')
  assert.equal(new URL(navigations.at(-1)!).searchParams.get('return_to'),context.location.href)
  authenticated=false
  await events.focus()
  assert.equal(nodes[1].textContent,'未登录')
})

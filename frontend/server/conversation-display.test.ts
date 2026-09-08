import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationTitle, recentConversations } from '../src/conversation-display.ts'
import { readTabLayout, saveTabLayout } from '../src/workspace-layout.ts'
test('old untitled conversations derive names but explicit titles survive', () => {
 const messages=[{role:'user',content:'什么是应用程序二进制接口（ABI）？',createdAt:100}]
 assert.equal(conversationTitle('新对话',messages),'什么是应用程序二进制接口（ABI）？')
 assert.equal(conversationTitle('系统基础',messages),'系统基础')
})
test('recent message time wins over bulk sync timestamps without mutating input', () => {
 const a={id:'a',updatedAt:9999,messages:[{role:'user',content:'旧',createdAt:1}]}
 const b={id:'b',updatedAt:2,messages:[{role:'user',content:'新',createdAt:2}]}
 const original=[a,b]; assert.deepEqual(recentConversations(original),[b,a]); assert.deepEqual(original,[a,b])
})
test('paper pages and selection survive layout serialization without shared chat cache', () => {
 const data=new Map<string,string>(); const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v)},removeItem:(k:string)=>{data.delete(k)}}
 const layout={tabs:[{kind:'chat',conversationId:'c'}],activeTabId:'c',splitTabId:'',drafts:{},pages:{c:{sheets:[{id:'paper',title:'追问',messages:[{content:'保留'}]}],activeSheetId:'paper'}}}
 saveTabLayout(storage,1,layout); assert.deepEqual(readTabLayout(storage,1),layout)
})

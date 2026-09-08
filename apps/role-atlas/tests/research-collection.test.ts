import test from "node:test";
import assert from "node:assert/strict";
import { recordModel, type CallStore } from "../lib/research-collection/record-model";
import { redact, bounded, sha256, safeName, pathToken, removeCredential } from "../lib/research-collection/format";
const context={projectId:"p",runId:"r",provider:"deepseek",model:"test"};
function capture(){const calls:unknown[]=[];const store:CallStore={async start(row){calls.push(row);},async finish(id,status,response,error){calls.push({id,status,response,error});}};return {calls,store};}
test("captures actual request and response once without changing streamed deltas",async()=>{
 const {calls,store}=capture();const input={system:"system",user:"chosen options",thinking:"disabled" as const,maxCompletionTokens:99};
 const wrapped=recordModel(async function*(){yield {type:"reasoning",delta:"reason"};yield {type:"text",delta:"answer"};},context,store);
 assert.deepEqual(await Array.fromAsync(wrapped(input)),[{type:"reasoning",delta:"reason"},{type:"text",delta:"answer"}]);
 const [start,end]=calls as Record<string,any>[];
 assert.equal(start.runId,"r");assert.equal(start.request.user.text,input.user);assert.equal(start.request.maxCompletionTokens,99);assert.equal(start.request.thinking,"disabled");assert.equal(start.request.reasoningEffort,"high");assert.equal(start.request.promptHash,await sha256(new TextEncoder().encode("system\nchosen options")));
 assert.equal(end.status,"completed");assert.equal(end.response.text,"answer");assert.equal(end.response.usage,null);assert.equal(end.id,start.id);
});
test("failed and early cancelled streams retain partial results and each retry has a new ID",async()=>{
 const {calls,store}=capture();const wrapped=recordModel(async function*(){yield {type:"text",delta:"partial"};throw new Error("provider failed");},context,store);
 await assert.rejects(async()=>{for await(const part of wrapped({system:"s",user:"u"}))void part;},/provider failed/);
 const it=wrapped({system:"s",user:"u"})[Symbol.asyncIterator]();await it.next();await it.return?.();
 const rows=calls as Record<string,any>[];
 assert.equal(rows[1].status,"failed");assert.equal(rows[1].response.text,"partial");assert.equal(rows[3].status,"cancelled");assert.notEqual(rows[0].id,rows[2].id);
});
test("explicit truncation and redaction preserve ordinary inputs",async()=>{
 const {store,calls}=capture();const wrapped=recordModel(async function*(){yield {type:"text",delta:"x".repeat(160010)};},context,store);
 for await(const part of wrapped({system:"s",user:"u".repeat(160002)}))void part;
 const rows=calls as Record<string,any>[];assert.equal(rows[0].request.user.truncated,true);assert.equal(rows[0].request.user.originalCharacters,160002);assert.equal(rows[1].response.textTruncated,true);
 assert.deepEqual(redact({apiKey:"s",nested:{authorization:"x",prompt:"task"},text:"Bearer abc123 sk-1234567890123456"}),{apiKey:"[REDACTED]",nested:{authorization:"[REDACTED]",prompt:"task"},text:"Bearer [REDACTED] [REDACTED_API_KEY]"});assert.equal(bounded("short").truncated,false);assert.equal(safeName("../坏/file"),"..___file");
});
test("record creation failure prevents an unrecorded model call",async()=>{
 let invoked=false;const wrapped=recordModel(async function*(){invoked=true;yield {type:"text",delta:"x"};},context,{async start(){throw new Error("db unavailable");},async finish(){}});
 await assert.rejects(async()=>{for await(const part of wrapped({system:"s",user:"u"}))void part;},/db unavailable/);assert.equal(invoked,false);
});

test("archive paths distinguish legacy IDs without directory traversal",()=>{assert.notEqual(pathToken("a:b"),pathToken("a_b"));assert.equal(pathToken("../x"),"%2E%2E%2Fx");});

test("known provider credentials are removed even when echoed without Bearer prefix",()=>{assert.deepEqual(removeCredential({error:"invalid abc-key",text:["abc-key"]},"abc-key"),{error:"invalid [REDACTED]",text:["[REDACTED]"]});});

import { ownerId, ownerName, matchesOwner } from "../lib/research-collection/owners";
test("admin owner filters use exact verified IDs and retain unassigned historical records",()=>{
 const rows=[{owner_subject_id:"learnflow:learner:1",owner_name:"同名测试员"},{owner_subject_id:"learnflow:learner:10",owner_name:"同名测试员"},{owner_subject_id:null}];
 assert.equal(rows.filter(r=>matchesOwner(r,"")).length,3);
 assert.deepEqual(rows.filter(r=>matchesOwner(r,"learnflow:learner:1")),[rows[0]]);
 assert.deepEqual(rows.filter(r=>matchesOwner(r,"unassigned")),[rows[2]]);
 assert.equal(ownerId(rows[2]),"");assert.equal(ownerName(rows[2]),"历史未归属");
 assert.equal(ownerName({owner_subject_id:"learnflow:learner:1",owner_name:"learnflow:learner:1",owner_username:"tester1"}),"tester1");
 assert.equal(ownerName({owner_subject_id:"learnflow:learner:1"}),"未记录名称");
});

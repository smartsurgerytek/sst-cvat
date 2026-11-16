// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../cvat-core/src/chunk-prefetch.ts'), 'utf8');
const api = {exports:{}};
new Function('exports','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText)(api.exports,api);
const Buffer = api.exports.default;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function downloader(){const calls=[];const pending=new Map();return {calls,pending,download(index){calls.push(index);return new Promise((resolve,reject)=>pending.set(index,{resolve,reject}));}};}

test('downloads ahead without waiting for decoder consumption and deduplicates requests', async()=>{
 const d=downloader();const b=new Buffer(d.download.bind(d));b.ahead(0,2,10);
 const a=b.get(0);const same=b.get(0);assert.equal(a,same);assert.deepEqual(d.calls,[0]);
 d.pending.get(0).resolve(new ArrayBuffer(4));await a;await tick();assert.deepEqual(d.calls,[0,1]);
 d.pending.get(1).resolve(new ArrayBuffer(5));await tick();assert.deepEqual(d.calls,[0,1,2]);
 assert.equal((await b.get(1)).byteLength,5);b.clear();
});
test('seeks discard obsolete queued speculation and prioritize requested chunk', async()=>{
 const d=downloader();const b=new Buffer(d.download.bind(d));b.ahead(0,5,20);b.ahead(10,2,20);const target=b.get(10);
 d.pending.get(0).resolve(new ArrayBuffer(1));await tick();assert.deepEqual(d.calls,[0,10]);
 d.pending.get(10).resolve(new ArrayBuffer(2));assert.equal((await target).byteLength,2);b.clear();
});
test('network failure can be retried and close settles waiting consumers',async()=>{
 const d=downloader();const b=new Buffer(d.download.bind(d));const first=b.get(1);d.pending.get(1).reject(new Error('offline'));await assert.rejects(first,/offline/);await tick();
 const retry=b.get(1);d.pending.get(1).resolve(new ArrayBuffer(3));assert.equal((await retry).byteLength,3);await tick();
 const pending=b.get(2);b.clear();await assert.rejects(pending,/closed/);
});
test('compressed cache evicts under its byte budget',async()=>{
 const calls=[];const b=new Buffer(async(index)=>{calls.push(index);return new ArrayBuffer(4);},5);
 b.ahead(0,0,3);await b.get(0);await tick();b.ahead(1,0,3);await b.get(1);await tick();
 await b.get(0);assert.deepEqual(calls,[0,1,0]);b.clear();
});
test('metadata invalidation never reuses an old in-flight response',async()=>{
 const d=downloader();const b=new Buffer(d.download.bind(d));const old=b.get(0);const oldRequest=d.pending.get(0);
 b.invalidate();await assert.rejects(old,/closed/);const fresh=b.get(0);oldRequest.resolve(new ArrayBuffer(1));await tick();
 assert.deepEqual(d.calls,[0,0]);d.pending.get(0).resolve(new ArrayBuffer(7));assert.equal((await fresh).byteLength,7);
 b.clear();await assert.rejects(b.get(0),/closed/);
});
test('paused forward prefetch fills its budget and resumes when playback advances', async()=>{
 const calls=[];const b=new Buffer(async(index)=>{calls.push(index);return new ArrayBuffer(4);},12);
 b.ahead(0,50,100);await tick();await tick();
 assert.deepEqual(calls,[0,1,2]);assert.deepEqual(b.downloaded(),[0,1,2]);
 b.ahead(1,50,100);await tick();await tick();
 assert.deepEqual(calls,[0,1,2,3]);assert.deepEqual(b.downloaded(),[1,2,3]);
 // A full speculative buffer must never block a foreground seek.
 await b.get(90);await tick();assert.equal(calls.at(-1),90);b.clear();
});
test('prefetch reaches end of video without requesting nonexistent chunks',async()=>{
 const calls=[];const b=new Buffer(async(index)=>{calls.push(index);return new ArrayBuffer(4);},100);
 b.ahead(7,50,10);await tick();await tick();assert.deepEqual(calls,[7,8,9]);b.clear();
});

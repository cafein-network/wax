import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, utimes, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, at, cli } from './chat-helpers.mjs';
import { createFeature, getFeature, listFeatures, scanFeatures, updateFeature } from '../src/workflow.mjs';
import { createBackup, validateBackup, previewRestore } from '../src/backup.mjs';
import { joinPresence, setPresence, listPresence } from '../src/chat/presence.mjs';
import { setPm, assignTask } from '../src/chat/team.mjs';
import { withFileLock } from '../src/file-lock.mjs';
import { installProject as installCodex } from '../scripts/install-project.mjs';
import { ChannelFeed, ChannelDrafts } from '../web/channel-state.mjs';
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';


test('channel generations reject stale A-B-A requests, preserve live events and typed drafts after sends',()=>{
 const feed=new ChannelFeed();const a=feed.begin('a');feed.begin('b');const latest=feed.begin('a');assert.equal(feed.merge('a',a,[{id:'old'}]),null);
 feed.receive('a',{id:'live',seq:2});assert.deepEqual(feed.merge('a',latest,[{id:'first',seq:1}]).map(m=>m.id),['first','live']);assert.equal(feed.receive('b',{id:'wrong'}),false);
 const drafts=new ChannelDrafts(),sent=drafts.edit('a','old');drafts.edit('b','new channel');assert.equal(drafts.sent('a',sent.version),true);assert.equal(drafts.read('b').body,'new channel');const request=drafts.edit('a','sent');drafts.edit('a','new typing');assert.equal(drafts.sent('a',request.version),false);assert.equal(drafts.read('a').body,'new typing');
});

test('office strolls leave chairs at the seat and avoid board positions; audio resumes without a backlog', async()=>{
 const { carriesChair, strollNodes, resumeBeat }=await import('../web/office/behavior.mjs');
 assert.equal(carriesChair({chair:true},true),true);assert.equal(carriesChair({chair:true,stroll:{returning:true}},true),false);
 const room={NODES:{b0:[0,0],b1:[1,0],b2:[2,0],p0:[3,0],seat:[4,0]},SEATS:{seat:{}}};
 assert.deepEqual(strollNodes(room,new Set(),'dev'),[{name:'p0',x:3}]);
 assert.deepEqual(resumeBeat(1,100,1,2),{nextBeat:100.05,index:101});assert.deepEqual(resumeBeat(101,100,1,2),{nextBeat:101,index:2});
});

test('office initialization can tick before configuration arrives',async()=>{
 const vm=await import('node:vm');const source=await readFile(new URL('../web/office/office.mjs',import.meta.url),'utf8');const fn=source.slice(source.indexOf('function updateScene('),source.indexOf('function walkTo('));
 vm.runInNewContext('const state={config:null};'+fn+';updateScene();');
});

test('switching channels during send clears an unchanged draft and live buffering ends with the snapshot',()=>{
 const drafts=new ChannelDrafts(),request=drafts.edit('a','sent');assert.equal(drafts.edit('a','sent').version,request.version);
 drafts.edit('b','other');assert.equal(drafts.sent('a',request.version),true);assert.equal(drafts.read('a').body,'');
 const feed=new ChannelFeed(),ticket=feed.begin('a');feed.receive('a',{id:'one',seq:1});assert.equal(feed.live.size,1);
 assert.equal(feed.merge('a',ticket,[]).length,1);assert.equal(feed.live.size,0);
 for(let i=0;i<1000;i++)feed.receive('a',{id:String(i)});assert.equal(feed.live.size,0);
});

test('extra-seat strolls leave exactly one chair and snapshot retries back off until recovery',async()=>{
 const {restingChairs,createSnapshotRetry}=await import('../web/office/behavior.mjs');
 assert.deepEqual(restingChairs([{visible:true,chair:true,stroll:{home:'meeting:w'}},{visible:true,chair:true,stroll:{home:'meeting:w'}}],['meeting:w']),['meeting:w']);
 let attempts=0,synced=0;const timers=[],errors=[];
 const retry=createSnapshotRetry({load:async()=>{if(++attempts<3)throw Error('offline');},onSynced:()=>synced++,onError:e=>errors.push(e.message),setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimer:()=>{}});
 const tick=()=>new Promise(resolve=>setImmediate(resolve));retry.start();await tick();assert.equal(timers[0].ms,1000);
 timers[0].fn();await tick();assert.equal(timers[1].ms,2000);timers[1].fn();await tick();assert.equal(synced,1);assert.equal(errors.length,2);
 retry.start();retry.stop();await tick();assert.equal(synced,1,'a stopped request cannot revive the UI');
});

test('persisted dashboard pages recreate the refresher, timer and event stream on every restore',async()=>{
 const vm=await import('node:vm'),source=(await readFile(new URL('../web/dashboard.mjs',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 const start=source.indexOf('let disconnect = null, refreshTimer;'),end=source.indexOf("try {\n  config = await api('/api/config');",start);
 const events={},log=[],instances=[];
 const createLatestRefresh=()=>{const instance={stop(){this.stopped=true;log.push('stop')}};instances.push(instance);return instance;};
 const context={window:{addEventListener(type,fn){events[type]=fn}},config:{},pending:null,date:'today',document:{hidden:false},refreshOptions:{},createLatestRefresh,
  connect:()=>{log.push('connect');return()=>log.push('disconnect')},setInterval:()=>{log.push('timer');return 1},clearInterval:()=>log.push('clearTimer'),clearTimeout:()=>{},refresh:()=>log.push('refresh'),refreshState:createLatestRefresh()};
 vm.runInNewContext(source.slice(start,end)+'\nstartLive();',context);
 for(let i=0;i<2;i++){events.pagehide();assert.equal(instances.at(-1).stopped,true);events.pageshow({persisted:true});assert.equal(instances.at(-1).stopped,undefined);}
 assert.equal(log.filter(x=>x==='connect').length,3);assert.equal(log.filter(x=>x==='disconnect').length,2);assert.equal(log.filter(x=>x==='refresh').length,2);
});

test('cached demo playback renders its stopped state before returning',async()=>{
 const vm=await import('node:vm');const source=await readFile(new URL('../web/workflow-demo.mjs',import.meta.url),'utf8');const lines=source.split('\n').filter(line=>line.startsWith("window.addEventListener('pagehide'")||line.startsWith("window.addEventListener('pageshow'"));
 let playing=true,label='pause';const listeners={};vm.runInNewContext(lines.join('\n'),{window:{addEventListener:(name,fn)=>listeners[name]=fn},stop:()=>{playing=false},render:()=>{label=playing?'pause':'play'}});listeners.pagehide();assert.equal(label,'play');listeners.pageshow({persisted:true});assert.equal(label,'play');
});

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
import { installCodex } from '../scripts/install-codex.mjs';
import { ChannelFeed, ChannelDrafts } from '../web/channel-state.mjs';
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';

test('idle timeout within the lease keeps PM names; a session resumes its allocated name and stays private', async t => {
 const initial=at('2026-10-16T00:00:00Z'),later=at('2026-10-16T00:11:00Z');
 const root=await project(t,['one']); const a=await joinPresence(root,{author:'pm',session:'session-a'},initial);
 await setPm(root,{author:a.author},initial); await setPresence(root,{author:'pm',session:a.session,state:'away'},initial);
 const b=await joinPresence(root,{author:'pm',session:'session-b'},later);assert.equal(b.author,'pm-2');
 assert.equal((await joinPresence(root,{author:'pm',session:'session-b'},later)).author,'pm-2');
 assert.ok((await listPresence(root)).every(a=>!('sessionHash' in a)&&!('session' in a)));
 await assert.rejects(joinPresence(root,{author:'new-pm',session:'session-a',rename:true},later),/PM/);
 await assignTask(root,{author:'pm',session:a.session,to:b.author,feature:'one',body:'test'},later);
 await setPresence(root,{author:b.author,session:b.session,state:'away'},later);assert.equal((await joinPresence(root,{author:b.author},later)).author,'pm-2-2');
});
test('explicit renames check collisions and Unicode suffixes remain valid',async t=>{
 const root=await project(t);const name='a'+'𠀀'.repeat(20);await joinPresence(root,{author:name});const next=await joinPresence(root,{author:name});assert.equal(next.author.isWellFormed(),true);
 assert.equal((await cli(root,['presence','--author',next.author,'--session',next.session,'--state','idle'])).code,0);
 const a=await joinPresence(root,{author:'alice',session:'a'});await joinPresence(root,{author:'bob'});
 assert.equal((await joinPresence(root,{author:'bob',session:a.session,rename:true})).author,'bob-2');
 assert.equal((await joinPresence(root,{author:'bob',session:a.session})).author,'bob-2');
 await assert.rejects(joinPresence(root,{author:'x',rename:true}),/session/);
});
test('damaged and foreign JSON do not disable healthy work; backups preserve raw bytes and warnings',async t=>{
 const root=await project(t,['good']);const dir=join(root,'.wax/features');await writeFile(join(dir,'bad.json'),'{broken');await writeFile(join(dir,'._good.json'),'resource fork');
 assert.equal((await listFeatures(root)).length,1);assert.equal((await scanFeatures(root)).issues.length,2);
 const saved=validateBackup(await createBackup(root));assert.equal(saved.complete,false);assert.equal(saved.damaged.find(x=>x.id==='bad').raw,'{broken');
 const target=await project(t);assert.equal((await previewRestore(target,saved)).damagedCount,2);
 await t.test('file symlinks are rejected when the OS permits creating them', async st => {
  const outside=join(root,'outside.json');await writeFile(outside,'{}');
  try { await symlink(outside,join(dir,'unsafe.json')); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { st.skip('Windows file symlink privilege is unavailable'); return; } throw error; }
  await assert.rejects(listFeatures(root),/심볼릭/);
 });
});
test('orphan and same-PID abandoned locks recover; canonical aliases queue behind a live owner',async t=>{
 const root=await project(t);const lock=join(root,'record.lock');await mkdir(lock);await utimes(lock,new Date(0),new Date(0));
 assert.equal(await withFileLock(lock,()=>42,{staleMs:1}),42);
 await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,token:'old-instance'}));assert.equal(await withFileLock(lock,()=>43),43);
 const alias=join(root,'alias');await symlink(root,alias,directoryLink);let release,entered=false;
 const first=withFileLock(lock,()=>new Promise(resolve=>{release=resolve}));while(!release)await new Promise(r=>setImmediate(r));
 const second=withFileLock(join(alias,'record.lock'),()=>{entered=true});await new Promise(r=>setImmediate(r));assert.equal(entered,false);release();await Promise.all([first,second]);assert.equal(entered,true);
 await createFeature(root,{id:'one',title:'one'});const featureLock=join(root,'.wax/features/one.lock');await mkdir(featureLock);await utimes(featureLock,new Date(0),new Date(0));await updateFeature(root,'one','edit',{title:'recovered',description:''});assert.equal((await getFeature(root,'one')).title,'recovered');
});
test('obsolete installer links are reported and removed, unrelated links survive',async t=>{
 const root=await project(t);await installCodex({project:root});const source=await realpath(fileURLToPath(new URL('..',import.meta.url))),path=join(root,'.agents/skills/wax-dashboard');await symlink(join(source,'skills/dashboard'),path,directoryLink);
 assert.equal((await installCodex({project:root,check:true})).ok,false);await installCodex({project:root});assert.equal((await installCodex({project:root,check:true})).ok,true);
});
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


test('dashboard status recognizes real and symlink project paths',async t=>{
 const {createChatServer}=await import('../src/chat/server.mjs');const {run}=await import('../src/chat/cli.mjs');const {once}=await import('node:events');
 const root=await project(t),alias=join(root,'project-alias');await symlink(root,alias,directoryLink);const server=createChatServer({root});t.after(()=>server.shutdown());server.listen(0,'127.0.0.1');await once(server,'listening');
 let output='';const code=await run(['serve','--status','--port',String(server.address().port),'--json'],{cwd:alias,env:{},stdout:{write(value){output+=value}}});assert.equal(code,0);assert.equal(JSON.parse(output).running,true);
});
test('independent processes serialize stale recovery and writes',async t=>{
 const {spawn}=await import('node:child_process');const root=await project(t),lock=join(root,'counter.lock'),counter=join(root,'counter');await writeFile(counter,'0');await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:2147483647}));
 const code=`import {withFileLock} from ${JSON.stringify(new URL('../src/file-lock.mjs',import.meta.url).href)};import {readFile,writeFile} from 'node:fs/promises';for(let i=0;i<12;i++)await withFileLock(process.argv[1],async()=>{const n=Number(await readFile(process.argv[2],'utf8'));await new Promise(r=>setTimeout(r,2));await writeFile(process.argv[2],String(n+1));},{timeoutMs:30000});`;
 await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code,lock,counter]);let err='';child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(err)));})));assert.equal(await readFile(counter,'utf8'),'48');
});


test('expired PM and task owner names transfer while recently active names remain protected',async t=>{
 const root=await project(t,['one']);const old=at('2026-10-14T00:00:00Z'),now=at('2026-10-16T00:00:00Z');
 await joinPresence(root,{author:'old',session:'expired'},old);
 assert.equal((await joinPresence(root,{author:'old',session:'replacement'},now)).author,'old');
 await joinPresence(root,{author:'active',session:'active'},now);
 assert.equal((await joinPresence(root,{author:'active',session:'other'},now)).author,'active-2');
 await joinPresence(root,{author:'boss',session:'boss'},old);await setPm(root,{author:'boss'});
 await joinPresence(root,{author:'worker',session:'worker'},old);await assignTask(root,{author:'boss',session:'boss',to:'worker',feature:'one',body:'work'},old);
 assert.equal((await joinPresence(root,{author:'boss',session:'new-boss'},now)).author,'boss');
 assert.equal((await joinPresence(root,{author:'worker',session:'new-worker'},now)).author,'worker');
 const file=join(root,'.wax/chat/presence.json'),data=JSON.parse(await readFile(file,'utf8'));
 delete data.agents.boss.sessionHash;delete data.agents.boss.schema;data.agents.boss.lastActive=old.now.toISOString();await writeFile(file,JSON.stringify(data));
 assert.equal((await joinPresence(root,{author:'boss',session:'legacy-resume'},now)).author,'boss');
});
test('rejoining an away session reactivates its lease and presence JSON hides its hash',async t=>{
 const root=await project(t);await joinPresence(root,{author:'amy',session:'amy-session'});
 const away=await setPresence(root,{author:'amy',session:'amy-session',state:'away'});assert.ok(!('sessionHash' in away));
 assert.equal((await joinPresence(root,{author:'amy',session:'amy-session'})).state,'idle');
 assert.equal((await joinPresence(root,{author:'amy',session:'another'})).author,'amy-2');
 const result=await cli(root,['presence','--author','amy','--session','amy-session','--state','working','--json']);assert.equal(result.code,0);assert.ok(!('sessionHash' in JSON.parse(result.stdout)));
});
test('a queued lock times out without bypassing or releasing the current owner',async t=>{
 const root=await project(t),path=join(root,'lease.lock');let release,entered=false;
 const first=withFileLock(path,()=>new Promise(resolve=>{release=resolve}));while(!release)await new Promise(resolve=>setImmediate(resolve));
 const started=Date.now();await assert.rejects(withFileLock(path,()=>{throw Error('must not enter')},{timeoutMs:50}),error=>error.status===409);
 assert.ok(Date.now()-started<500);
 const third=withFileLock(path,()=>{entered=true});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(entered,false);
 release();await Promise.all([first,third]);assert.equal(entered,true);
});
test('a fresh ownerless lock is not reclaimed before its grace period',async t=>{
 const root=await project(t),path=join(root,'new.lock');await mkdir(path);
 await assert.rejects(withFileLock(path,()=>{throw Error('must not enter')},{timeoutMs:40,staleMs:5000}),error=>error.status===409);
});
test('damaged backup bytes, BOMs, size and item limits round trip without exposing raw previews',async t=>{
 const root=await project(t),dir=join(root,'.wax/features');await mkdir(dir,{recursive:true});
 const bytes=Buffer.from([255,254,0,1]);await writeFile(join(dir,'binary.json'),bytes);
 const bom=Buffer.from([239,187,191,123]);await writeFile(join(dir,'bom.json'),bom);
 await writeFile(join(dir,'large.json'),Buffer.alloc(1_000_001,65));await writeFile(join(dir,'._foreign.json'),bytes);
 for(let i=0;i<999;i++)await writeFile(join(dir,`z-${String(i).padStart(4,'0')}.json`),'{');
 const backup=validateBackup(await createBackup(root));assert.equal(backup.damaged.length,1000);assert.equal(backup.damagedOmitted,3);
 assert.deepEqual(Buffer.from(backup.damaged.find(x=>x.id==='binary').rawBase64,'base64'),bytes);
 assert.deepEqual(Buffer.from(backup.damaged.find(x=>x.id==='bom').raw),bom);
 assert.equal(backup.damaged.find(x=>x.id==='large').rawOmitted,true);assert.equal(backup.damaged.find(x=>x.id==='large').size,1_000_001);
 assert.ok(!('raw' in backup.damaged.find(x=>x.file==='._foreign.json'))&&!('rawBase64' in backup.damaged.find(x=>x.file==='._foreign.json')));
 const preview=await previewRestore(root,backup);assert.equal(preview.damagedCount,1003);assert.ok(preview.warnings.every(x=>!('raw' in x)&&!('rawBase64' in x)));
});
test('installer detects obsolete links from previous unpack locations and reports unrelated broken wax links',async t=>{
 const root=await project(t);await installCodex({project:root});
 const dir=join(root,'.agents/skills');await symlink(join(root,'removed-source/skills/dashboard'),join(dir,'wax-dashboard'),directoryLink);
 await symlink(join(root,'missing-custom'),join(dir,'wax-custom'),directoryLink);
 const check=await installCodex({project:root,check:true});assert.deepEqual(check.obsolete.map(x=>x.name),['wax-dashboard']);assert.deepEqual(check.warnings.map(x=>x.name),['wax-custom']);
 const result=await installCodex({project:root});assert.equal(result.ok,true);assert.deepEqual(result.obsolete,[]);assert.deepEqual(result.warnings.map(x=>x.name),['wax-custom']);
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


test('locks acquire, release and recover when birthtime is ctime or zero',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const root=await project(t),moduleUrl=new URL('../src/file-lock.mjs',import.meta.url).href;
 const source=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import assert from 'node:assert/strict';const original=fs.promises.lstat;fs.promises.lstat=async(...args)=>{const s=await original(...args);s.birthtimeMs=process.argv[2]==='zero'?0:s.ctimeMs;return s;};syncBuiltinESMExports();const {withFileLock}=await import(${JSON.stringify(moduleUrl)});const path=join(process.argv[1],process.argv[2]+'.lock');for(let i=0;i<20;i++)assert.equal(await withFileLock(path,()=>i),i);await assert.rejects(fs.promises.lstat(path),{code:'ENOENT'});await fs.promises.mkdir(path);await fs.promises.writeFile(join(path,'owner.json'),JSON.stringify({pid:2147483647,token:'dead'}));assert.equal(await withFileLock(path,()=>42),42);await assert.rejects(fs.promises.lstat(path),{code:'ENOENT'});await fs.promises.mkdir(path);await fs.promises.utimes(path,new Date(0),new Date(0));assert.equal(await withFileLock(path,()=>43,{staleMs:1}),43);console.log('OK');`;
 for(const mode of ['ctime','zero'])assert.match((await promisify(execFile)(process.execPath,['--input-type=module','-e',source,root,mode])).stdout,/OK/);
});
test('expired PM and task names keep their roles but reject every former owner write',async t=>{
 const {postMessage,readMessages}=await import('../src/chat/channels.mjs');const {postNote,saveReport}=await import('../src/chat/board.mjs');const {saveDailyReport}=await import('../src/chat/daily.mjs');const {updateTask,getTeam,listTasks}=await import('../src/chat/team.mjs');
 const root=await project(t,['one']),old=at('2026-10-14T00:00:00Z'),now=at('2026-10-16T00:00:00Z');
 await joinPresence(root,{author:'pm',session:'old-pm',kind:'codex',model:'gpt-5-codex'},old);await setPm(root,{author:'pm'});
 await joinPresence(root,{author:'amy',session:'old-amy',kind:'codex',model:'gpt-5-codex'},old);
 const task=await assignTask(root,{author:'pm',session:'old-pm',to:'amy',feature:'one',body:'work'},old);
 assert.equal((await joinPresence(root,{author:'pm',session:'new-pm',kind:'claude'},now)).author,'pm');
 const amy=await joinPresence(root,{author:'amy',session:'new-amy',kind:'claude'},now);assert.equal(amy.author,'amy');assert.equal(amy.kind,'claude');assert.equal(amy.model,null);
 const rejected=[()=>setPresence(root,{author:'amy',session:'old-amy',state:'working'},now),()=>postMessage(root,'one',{author:'amy',session:'old-amy',body:'stale'},now),()=>postMessage(root,'one',{author:'amy',body:'missing-token'},now),()=>postNote(root,'one',{author:'amy',session:'old-amy',type:'opinion',body:'stale'},now),()=>saveReport(root,'one',{author:'amy',session:'old-amy',markdown:'stale'},now),()=>saveDailyReport(root,{author:'amy',session:'old-amy',markdown:'stale'},now),()=>assignTask(root,{author:'pm',session:'old-pm',to:'amy',feature:'one',body:'stale'},now),()=>updateTask(root,task.id,'accept',{author:'amy',session:'old-amy'},now)];
 for(const action of rejected)await assert.rejects(action,error=>error.status===409);
 assert.deepEqual((await readMessages(root,'one')).messages,[]);assert.equal((await listTasks(root)).length,1);assert.equal((await listTasks(root))[0].status,'open');
 assert.equal((await getTeam(root)).pm.author,'pm');assert.equal((await updateTask(root,task.id,'accept',{author:'amy',session:'new-amy'},now)).status,'accepted');
 await assignTask(root,{author:'pm',session:'new-pm',to:'amy',feature:'one',body:'current'},now);assert.equal((await listPresence(root)).find(x=>x.author==='pm').kind,'claude');
 await postMessage(root,'one',{author:'amy',session:'new-amy',body:'current'},now);
 assert.equal((await joinPresence(root,{author:'amy',session:'old-amy'},now)).author,'amy-2');
 const post=await cli(root,['post','one','--author','amy','--session','new-amy','--message','cli-current']);assert.equal(post.code,0,post.stderr);
 const stale=await cli(root,['post','one','--author','amy','--session','old-amy','--message','cli-stale']);assert.equal(stale.code,1);assert.match(stale.stderr,/409|소유권/);
 const content=await readFile(join(root,'.wax/chat/channels/one.jsonl'),'utf8');assert.doesNotMatch(content,/old-amy|new-amy|sessionHash/);
});
test('a name cannot be handed over in the middle of a checked write',async t=>{
 const {withPresenceActivity}=await import('../src/chat/presence.mjs');const root=await project(t);const old=at('2026-10-14T00:00:00Z'),now=at('2026-10-16T00:00:00Z');
 await joinPresence(root,{author:'amy',session:'old'},old);let release,entered=false;
 const write=withPresenceActivity(root,{author:'amy',session:'old'},()=>new Promise(resolve=>{release=resolve}),now);while(!release)await new Promise(resolve=>setImmediate(resolve));
 const next=joinPresence(root,{author:'amy',session:'new'},now).then(result=>{entered=true;return result});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(entered,false);release();await write;assert.equal((await next).author,'amy-2');
});
test('recent legacy roles migrate on join; direct presence is marked and future clocks do not pin names',async t=>{
 const root=await project(t),now=at('2026-10-16T00:00:00Z');await setPresence(root,{author:'direct',kind:'codex',model:'gpt-5-codex',state:'working'},now);
 const file=join(root,'.wax/chat/presence.json');let data=JSON.parse(await readFile(file,'utf8'));assert.equal(data.agents.direct.schema,2);assert.equal((await joinPresence(root,{author:'direct',session:'early'},now)).author,'direct-2');
 await setPm(root,{author:'legacy'});data=JSON.parse(await readFile(file,'utf8'));data.agents.legacy={author:'legacy',kind:'codex',model:'gpt-old',state:'working',lastActive:'2026-10-15T23:00:00Z'};await writeFile(file,JSON.stringify(data));
 const legacy=await joinPresence(root,{author:'legacy',session:'migrated',kind:'claude'},now);assert.equal(legacy.author,'legacy');assert.equal(legacy.model,null);
 await joinPresence(root,{author:'future',session:'future'},at('2099-01-01T00:00:00Z'));assert.equal((await joinPresence(root,{author:'future',session:'present'},now)).author,'future');
});
test('backup enforces total encoded raw budget and preserves omission metadata',async t=>{
 const root=await project(t),dir=join(root,'.wax/features');await mkdir(dir,{recursive:true});await writeFile(join(dir,'a.json'),'{bad');await writeFile(join(dir,'b.json'),'{bad');await writeFile(join(dir,'c.json'),Buffer.from([255]));
 const backup=validateBackup(await createBackup(root,{rawBudget:10}));assert.equal(backup.damaged[0].raw,'{bad');assert.ok(backup.damaged.slice(1).every(x=>x.rawOmitted&&x.omittedReason==='total-limit'&&x.size>0));
 const preview=await previewRestore(root,backup);assert.equal(preview.damagedCount,3);assert.equal(preview.warnings[1].omittedReason,'total-limit');
 const raw='x'.repeat(1_000_000);assert.throws(()=>validateBackup({format:'wax-workspace',version:1,createdAt:new Date().toISOString(),features:[],damaged:Array.from({length:68},(_,i)=>({file:i+'.json',message:'bad',raw})),checksum:'invalid'}),/체크섬/);
});
test('installer repairs all managed dangling links while keeping unrelated user links',async t=>{
 const {rm,lstat}=await import('node:fs/promises');const root=await project(t),first=await installCodex({project:root});
 for(const item of first.skills){await rm(item.path);await symlink(join(root,'deleted-source',item.name),item.path,directoryLink);}
 const custom=join(root,'.agents/skills/wax-custom');await symlink(join(root,'user-missing'),custom,directoryLink);const check=await installCodex({project:root,check:true});assert.equal(check.skills.filter(x=>x.status==='stale').length,13);
 const repaired=await installCodex({project:root});assert.equal(repaired.ok,true);assert.equal(repaired.warnings[0].name,'wax-custom');assert.ok((await lstat(custom)).isSymbolicLink());assert.equal((await installCodex({project:root,check:true})).ok,true);
});
test('cached demo playback renders its stopped state before returning',async()=>{
 const vm=await import('node:vm');const source=await readFile(new URL('../web/workflow-demo.mjs',import.meta.url),'utf8');const lines=source.split('\n').filter(line=>line.startsWith("window.addEventListener('pagehide'")||line.startsWith("window.addEventListener('pageshow'"));
 let playing=true,label='pause';const listeners={};vm.runInNewContext(lines.join('\n'),{window:{addEventListener:(name,fn)=>listeners[name]=fn},stop:()=>{playing=false},render:()=>{label=playing?'pause':'play'}});listeners.pagehide();assert.equal(label,'play');listeners.pageshow({persisted:true});assert.equal(label,'play');
});

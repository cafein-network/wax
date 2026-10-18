import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, at } from './chat-helpers.mjs';
import { joinPresence, setPresence, listPresence } from '../src/chat/presence.mjs';
import { setPm, assignTask, updateTask } from '../src/chat/team.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { createFeature } from '../src/workflow.mjs';
import { createBackup, validateBackup, previewRestore, restoreBackup } from '../src/backup.mjs';
import { createChatServer } from '../src/chat/server.mjs';

test('all host instructions carry the saved session on concrete named writes', async t => {
 const commands=['init','join','plan','design','implement','review','report','status','iterate','chat','daily','pm','work'];
 let count=0;
 for(const command of commands) for(const path of [`commands/${command}.md`,`commands/wax/${command}.toml`,`skills/${command}/SKILL.md`]) {
  const text=await readFile(new URL('../'+path,import.meta.url),'utf8');
  const writes=/\bCLI chat (?:presence|post|assign|board (?:post|report)|daily report|task \S+)(?:(?!\bCLI\b)[^\n])*?--author <[^>]+>(?: --session <saved-session-id>)?/g;
  for(const match of text.matchAll(writes)){count++;assert.ok(match[0].endsWith('--session <saved-session-id>'),`${path}: ${match[0]}`);}
 }
 assert.ok(count>=195,`checked ${count} commands across three hosts`);
 const root=await project(t);
 const agent=await joinPresence(root,{author:'worker'});
 await assert.rejects(setPresence(root,{author:agent.author,state:'working'}),/이 명령에 --session <ID>/);
 await setPresence(root,{author:agent.author,session:agent.session,state:'working'});
});

test('PM and task names assigned before first join can be claimed and used',async t=>{
 const root=await project(t,['one']);await setPm(root,{author:'boss',kind:'codex'});
 const boss=await joinPresence(root,{author:'boss',kind:'codex'});assert.equal(boss.author,'boss');
 const task=await assignTask(root,{author:boss.author,session:boss.session,to:'worker',feature:'one',body:'work'});
 const worker=await joinPresence(root,{author:'worker',kind:'claude'});assert.equal(worker.author,'worker');
 assert.equal((await updateTask(root,task.id,'accept',{author:worker.author,session:worker.session})).status,'accepted');
});

test('legacy backup over 64 MiB restores valid features and still checks integrity',async t=>{
 const root=await project(t);await createFeature(root,{id:'one',title:'one'});
 const {checksum,...data}=await createBackup(root);
 const raw='x'.repeat(1_000_000);data.damaged=Array.from({length:68},(_,i)=>({file:i+'.json',message:'legacy damage',raw}));data.complete=false;
 const backup={...data,checksum:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
 assert.equal(validateBackup(backup),backup);
 const destination=await project(t),preview=await previewRestore(destination,backup);
 assert.equal(preview.newCount,1);assert.ok(preview.warnings.every(x=>!('raw' in x)));
 assert.deepEqual((await restoreBackup(destination,backup,{fingerprint:preview.fingerprint})).restored,['one']);
 backup.damaged[0].raw='changed';assert.throws(()=>validateBackup(backup),/체크섬/);
});

test('a recent legacy host keeps its name against a different host during upgrade',async t=>{
 const root=await project(t),now=at('2026-10-16T00:00:00Z');await setPresence(root,{author:'seed',state:'idle'},now);
 const file=join(root,'.wax/chat/presence.json'),data=JSON.parse(await readFile(file,'utf8'));
 data.agents.legacy={author:'legacy',kind:'codex',state:'working',lastActive:'2026-10-15T23:59:00Z'};await writeFile(file,JSON.stringify(data));
 assert.equal((await joinPresence(root,{author:'legacy',kind:'claude'},now)).author,'legacy-2');
 assert.equal((await joinPresence(root,{author:'legacy',kind:'codex'},now)).author,'legacy');
});

test('ownerless replacement mtime wins over stale birthtime without statx',async t=>{
 const root=await project(t),moduleUrl=new URL('../src/file-lock.mjs',import.meta.url).href;
 const source=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';import {join} from 'node:path';const path=join(process.argv[1],'replacement.lock');await fs.promises.mkdir(path);const original=fs.promises.lstat;let seen=false;fs.promises.lstat=async(...args)=>{const s=await original(...args);s.birthtimeMs=0;if(args[0]===path&&!seen){seen=true;s.mtimeMs=0;}return s;};syncBuiltinESMExports();const {withFileLock}=await import(${JSON.stringify(moduleUrl)});await assert.rejects(withFileLock(path,()=>assert.fail('fresh replacement was reclaimed'),{timeoutMs:50,staleMs:1000}));assert.ok((await fs.promises.lstat(path)).isDirectory());`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source,root],{encoding:'utf8',timeout:3000});assert.equal(result.status,0,result.stderr);
});

test('authenticated dashboard writes survive an agent collision without weakening CLI fencing',async t=>{
 const root=await project(t,['one']),agent=await joinPresence(root,{author:'manager',kind:'codex'});
 const server=createChatServer({root,env:{WAX_CHAT_USER:'manager'}});await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>server.shutdown());
 const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json();
 const post=(path,data,token=config.token)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-chat-token':token},body:JSON.stringify(data)});
 assert.equal((await post('/api/channels/one/messages',{body:'human message'},'wrong')).status,403);
 const message=await post('/api/channels/one/messages',{body:'human message'});assert.equal(message.status,201);assert.equal((await message.json()).kind,'human');
 assert.equal((await post('/api/board/one/notes',{body:'human note',type:'opinion'})).status,201);
 assert.equal((await post('/api/team/pm',{self:true})).status,200);
 const taskResponse=await post('/api/tasks',{feature:'one',to:'manager',body:'human task'});assert.equal(taskResponse.status,201);const task=await taskResponse.json();
 assert.equal((await post(`/api/tasks/${task.id}/accept`,{})).status,200);
 await assert.rejects(postMessage(root,'one',{author:'manager',kind:'human',body:'CLI cannot bypass'}),/--session/);
 await postMessage(root,'one',{author:'manager',session:agent.session,body:'agent remains owner'});
 assert.equal((await listPresence(root)).find(x=>x.author==='manager').kind,'codex');
 assert.equal((await joinPresence(root,{author:'manager',kind:'codex'})).author,'manager-2');
 assert.equal((await joinPresence(root,{author:'manager',session:agent.session,kind:'codex'})).author,'manager');
});

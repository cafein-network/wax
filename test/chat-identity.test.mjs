import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, utimes, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, at, cli } from './chat-helpers.mjs';
import { joinPresence, setPresence, listPresence, reserveDashboardUser } from '../src/chat/presence.mjs';
import { setPm, assignTask, updateTask } from '../src/chat/team.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { createFeature, getFeature, listFeatures, scanFeatures, updateFeature } from '../src/workflow.mjs';
import { createBackup, validateBackup, previewRestore, restoreBackup } from '../src/backup.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { withFileLock } from '../src/file-lock.mjs';
import { fileURLToPath } from 'node:url';
import { installProject as installCodex } from '../scripts/install-project.mjs';
import { ChannelFeed, ChannelDrafts } from '../web/channel-state.mjs';
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';


test('all host instructions carry the saved session on concrete named writes', async t => {
 const commands=['init','join','plan','design','implement','review','report','status','iterate','chat','daily','pm','work'];
 let count=0;
 for(const command of commands) for(const path of [`commands/${command}.md`,`commands/wax/${command}.toml`,`skills/${command}/SKILL.md`]) {
  const text=await readFile(new URL('../'+path,import.meta.url),'utf8');
  const writes=/\bCLI chat (?:presence|post|assign|board (?:post|report)|daily report|task \S+)(?:(?!\bCLI\b)[^\n])*?--author <[^>]+>(?: --session <saved-session-id>)?/g;
  for(const match of text.matchAll(writes)){count++;assert.ok(match[0].endsWith('--session <saved-session-id>'),`${path}: ${match[0]}`);}
 }
 assert.ok(count>=170,`checked ${count} commands across three hosts`);
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

test('a recent legacy host keeps its name against a different host during upgrade',async t=>{
 const root=await project(t),now=at('2026-10-16T00:00:00Z');await setPresence(root,{author:'seed',state:'idle'},now);
 const file=join(root,'.wax/chat/presence.json'),data=JSON.parse(await readFile(file,'utf8'));
 data.agents.legacy={author:'legacy',kind:'codex',state:'working',lastActive:'2026-10-15T23:59:00Z'};await writeFile(file,JSON.stringify(data));
 assert.equal((await joinPresence(root,{author:'legacy',kind:'claude'},now)).author,'legacy-2');
 assert.equal((await joinPresence(root,{author:'legacy',kind:'codex'},now)).author,'legacy');
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

test('human-kind CLI records expire and a reserved dashboard name remains resumable by its owner',async t=>{
 const root=await project(t),old=at('2026-10-14T00:00:00Z'),now=at('2026-10-16T00:00:00Z');
 await setPresence(root,{author:'worker',kind:'human',state:'idle'},old);
 assert.equal((await joinPresence(root,{author:'worker',kind:'codex'},now)).author,'worker');
 const person=await joinPresence(root,{author:'사람',kind:'codex'},now);await reserveDashboardUser(root,'사람');
 assert.equal((await joinPresence(root,{author:'사람',session:person.session,kind:'codex'},now)).author,'사람');
 assert.equal((await joinPresence(root,{author:'사람',kind:'codex'},now)).author,'사람-2');
});

test('dashboard startup persists its configured name for joins in another process before any human post',async t=>{
 const root=await project(t),server=createChatServer({root,env:{WAX_CHAT_USER:'custom-boss',WAX_TOOL_NEWS:'off'}});await server.startWatching();
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>server.shutdown());
 const joined=await cli(root,['join','--author','custom-boss','--kind','codex','--json']);assert.equal(joined.code,0,joined.stderr);assert.equal(JSON.parse(joined.stdout).author,'custom-boss-2');
 const news=await(await fetch(`http://127.0.0.1:${server.address().port}/api/tools/news`)).json();assert.equal(news.mode,'bundled');
});

test('init and join feature instructions wait for a join token and human CLI output describes every write',async t=>{
 for(const command of ['init','join']){
  const text=await readFile(new URL(`../skills/${command}/SKILL.md`,import.meta.url),'utf8');assert.match(text,/do not run presence before joining/);
 }
 const root=await project(t),joined=await cli(root,['join','--author','worker','--kind','codex']);assert.equal(joined.code,0);assert.match(joined.stdout,/재참여와 모든 쓰기 명령에 --session/);
});

test('the dashboard shows one person, the 대표, even when older human names remain in presence', async t => {
  const root = await project(t), now = new Date();
  await setPresence(root, { author: '사람', kind: 'human', state: 'idle' }, { now });
  await setPresence(root, { author: '대표', kind: 'human', state: 'idle' }, { now });
  await setPresence(root, { author: 'worker', kind: 'codex', state: 'idle' }, { now });
  const server = createChatServer({ root, env: { WAX_TOOL_NEWS: 'off' } });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.user, '대표');
  const presence = await (await fetch(`${base}/api/presence`)).json();
  assert.deepEqual(presence.filter(a => a.kind === 'human').map(a => a.author), ['대표']);
  assert.ok(presence.some(a => a.author === 'worker'));
  const day = await (await fetch(`${base}/api/daily`)).json();
  assert.deepEqual(day.agents.filter(a => a.kind === 'human').map(a => a.author), ['대표']);
});

test('corrupt presence does not block startup or healthy reads, and repaired identity can write without restarting', async t => {
 const root = await project(t, ['healthy']);
 const dir = join(root, '.wax/chat'); await mkdir(dir, { recursive: true });
 const presence = join(dir, 'presence.json'); await writeFile(presence, '{broken');
 t.mock.method(console, 'error', () => {});
 const server = createChatServer({ root, env: { WAX_CHAT_USER: '관리자', WAX_TOOL_NEWS: 'off' }, intervalMs: 100 });
 t.after(() => server.shutdown());
 await server.startWatching(); assert.equal(server.watcher.running, true);
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const base = `http://127.0.0.1:${server.address().port}`;
 for (const path of ['/', '/office', '/api/config', '/api/features', '/api/channels', '/api/tools/news']) assert.equal((await fetch(base + path)).status, 200, path);
 assert.equal(await readFile(presence, 'utf8'), '{broken');
 const config = await (await fetch(base + '/api/config')).json();
 const post = token => fetch(base + '/api/channels/healthy/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-token': token }, body: JSON.stringify({ body: '수정 후 쓰기' }) });
 assert.equal((await post('wrong')).status, 403);
 assert.equal((await post(config.token)).status, 500);
 await writeFile(presence, JSON.stringify({ schema: 2, agents: {} }));
 assert.equal((await post(config.token)).status, 201);
 assert.equal(JSON.parse(await readFile(presence, 'utf8')).dashboardAuthor, '관리자');
 await server.watcher.tick(); assert.equal((await fetch(base + '/api/presence')).status, 200);
});

test('read-only project startup serves static pages and healthy reads without requiring a writable identity', async t => {
 const root = await project(t, ['healthy']);
 const source = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import assert from 'node:assert/strict';
 const original=fs.promises.mkdir; fs.promises.mkdir=async(path,...args)=>{if(String(path).startsWith(process.argv[1]))throw Object.assign(new Error('read only'),{code:'EACCES'});return original(path,...args);};syncBuiltinESMExports();
 const {createChatServer}=await import(${JSON.stringify(new URL('../src/chat/server.mjs', import.meta.url).href)});
 console.error=()=>{};const server=createChatServer({root:process.argv[1],env:{WAX_TOOL_NEWS:'off'}});
 try{await server.startWatching();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 for(const path of ['/','/office','/api/config','/api/channels','/api/features'])assert.equal((await fetch(base+path)).status,200,path);
 assert.equal(fs.existsSync(process.argv[1]+'/.wax/chat'),false);}finally{await server.shutdown();}`;
 const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, root], { encoding: 'utf8', timeout: 8000 });
 assert.equal(child.status, 0, child.stderr || String(child.error));
});

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

test('re-checking tool versions and official news needs the page token; a GET only reads what is remembered', async t => {
 const root=await project(t),server=createChatServer({root,env:{WAX_TOOL_NEWS:'off'}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(()=>server.shutdown());
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(`${base}/api/config`)).json();
 const post=(path,headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:'{}'});
 assert.equal((await post('/api/tools/refresh')).status,403);
 assert.equal((await post('/api/tools/news/refresh')).status,403);
 assert.equal((await post('/api/tools/news/refresh',{'x-chat-token':token})).status,200);
 assert.equal((await(await fetch(`${base}/api/tools/news?fresh=1`)).json()).mode,'bundled');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { project, at, cli } from './chat-helpers.mjs';
import { joinPresence, setPresence, reserveDashboardUser } from '../src/chat/presence.mjs';
import { createChatServer } from '../src/chat/server.mjs';

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

test('every published lock already contains its owner, including fallback stat filesystems',async t=>{
 const root=await project(t),moduleUrl=new URL('../src/file-lock.mjs',import.meta.url).href;
 const source=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';import {join} from 'node:path';const original=fs.promises.rename,stat=fs.promises.lstat;let published=0;fs.promises.lstat=async(...args)=>{const s=await stat(...args);s.birthtimeMs=0;return s;};fs.promises.rename=async(from,to)=>{if(from.includes('.pending-')){const owner=JSON.parse(await fs.promises.readFile(join(from,'owner.json'),'utf8'));assert.equal(owner.pid,process.pid);assert.ok(owner.token);published++;}return original(from,to);};syncBuiltinESMExports();const {withFileLock}=await import(${JSON.stringify(moduleUrl)});for(let i=0;i<20;i++)assert.equal(await withFileLock(join(process.argv[1],'x.lock'),()=>i),i);assert.equal(published,20);assert.deepEqual(await fs.promises.readdir(process.argv[1]),[]);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',source,root],{encoding:'utf8',timeout:3000});assert.equal(child.status,0,child.stderr);
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

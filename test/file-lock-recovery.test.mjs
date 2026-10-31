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


test('ownerless replacement mtime wins over stale birthtime without statx',async t=>{
 const root=await project(t),moduleUrl=new URL('../src/file-lock.mjs',import.meta.url).href;
 const source=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';import {join} from 'node:path';const path=join(process.argv[1],'replacement.lock');await fs.promises.mkdir(path);const original=fs.promises.lstat;let seen=false;fs.promises.lstat=async(...args)=>{const s=await original(...args);s.birthtimeMs=0;if(args[0]===path&&!seen){seen=true;s.mtimeMs=0;}return s;};syncBuiltinESMExports();const {withFileLock}=await import(${JSON.stringify(moduleUrl)});await assert.rejects(withFileLock(path,()=>assert.fail('fresh replacement was reclaimed'),{timeoutMs:50,staleMs:1000}));assert.ok((await fs.promises.lstat(path)).isDirectory());`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source,root],{encoding:'utf8',timeout:3000});assert.equal(result.status,0,result.stderr);
});

test('every published lock already contains its owner, including fallback stat filesystems',async t=>{
 const root=await project(t),moduleUrl=new URL('../src/file-lock.mjs',import.meta.url).href;
 const source=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';import {join} from 'node:path';const original=fs.promises.rename,stat=fs.promises.lstat;let published=0;fs.promises.lstat=async(...args)=>{const s=await stat(...args);s.birthtimeMs=0;return s;};fs.promises.rename=async(from,to)=>{if(from.includes('.pending-')){const owner=JSON.parse(await fs.promises.readFile(join(from,'owner.json'),'utf8'));assert.equal(owner.pid,process.pid);assert.ok(owner.token);published++;}return original(from,to);};syncBuiltinESMExports();const {withFileLock}=await import(${JSON.stringify(moduleUrl)});for(let i=0;i<20;i++)assert.equal(await withFileLock(join(process.argv[1],'x.lock'),()=>i),i);assert.equal(published,20);assert.deepEqual(await fs.promises.readdir(process.argv[1]),[]);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',source,root],{encoding:'utf8',timeout:10000});assert.equal(child.status,0,child.stderr);
});

test('abandoned pending lock directories are swept while live, fresh and unrelated candidates remain', async t => {
 const root = await project(t), lock = join(root, 'record.lock');
 const orphan = `${lock}.pending-${randomUUID()}`, live = `${lock}.pending-${randomUUID()}`, fresh = `${lock}.pending-${randomUUID()}`, unrelated = join(root, `other.lock.pending-${randomUUID()}`);
 for (const path of [orphan, live, fresh, unrelated]) {
  await mkdir(path); await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: path === live ? process.ppid : 2147483647, token: randomUUID() }));
  if (path !== fresh) await utimes(path, new Date(0), new Date(0));
 }
 await withFileLock(lock, () => {});
 assert.deepEqual((await readdir(root)).sort(), [live, fresh, unrelated].map(path => path.slice(root.length + 1)).sort());
});

test('Windows transient EPERM while publishing to a missing destination retries instead of failing immediately', async t => {
 const root = await project(t);
 const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
 Object.defineProperty(process,'platform',{value:'win32'});const original=fs.promises.rename;let attempts=0;
 fs.promises.rename=async(from,to)=>{if(from.includes('.pending-')&&++attempts<3)throw Object.assign(new Error('scanner holds candidate'),{code:'EPERM'});return original(from,to);};syncBuiltinESMExports();
 const {withFileLock}=await import(${JSON.stringify(new URL('../src/file-lock.mjs', import.meta.url).href)});
 assert.equal(await withFileLock(process.argv[1]+'/record.lock',()=>42),42);assert.equal(attempts,3);assert.deepEqual(await fs.promises.readdir(process.argv[1]),[]);`;
 const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, root], { encoding: 'utf8', timeout: 4000 });
 assert.equal(child.status, 0, child.stderr || String(child.error));
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

test('independent processes serialize stale recovery and writes',async t=>{
 const {spawn}=await import('node:child_process');const root=await project(t),lock=join(root,'counter.lock'),counter=join(root,'counter');await writeFile(counter,'0');await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({pid:2147483647}));
 const code=`import {withFileLock} from ${JSON.stringify(new URL('../src/file-lock.mjs',import.meta.url).href)};import {readFile,writeFile} from 'node:fs/promises';for(let i=0;i<12;i++)await withFileLock(process.argv[1],async()=>{const n=Number(await readFile(process.argv[2],'utf8'));await new Promise(r=>setTimeout(r,2));await writeFile(process.argv[2],String(n+1));},{timeoutMs:30000});`;
 await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code,lock,counter]);let err='';child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(err)));})));assert.equal(await readFile(counter,'utf8'),'48');
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

test('locks acquire, release and recover when birthtime is ctime or zero',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const root=await project(t),moduleUrl=new URL('../src/file-lock.mjs',import.meta.url).href;
 const source=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {join} from 'node:path';import assert from 'node:assert/strict';const original=fs.promises.lstat;fs.promises.lstat=async(...args)=>{const s=await original(...args);s.birthtimeMs=process.argv[2]==='zero'?0:s.ctimeMs;return s;};syncBuiltinESMExports();const {withFileLock}=await import(${JSON.stringify(moduleUrl)});const path=join(process.argv[1],process.argv[2]+'.lock');for(let i=0;i<20;i++)assert.equal(await withFileLock(path,()=>i),i);await assert.rejects(fs.promises.lstat(path),{code:'ENOENT'});await fs.promises.mkdir(path);await fs.promises.writeFile(join(path,'owner.json'),JSON.stringify({pid:2147483647,token:'dead'}));assert.equal(await withFileLock(path,()=>42),42);await assert.rejects(fs.promises.lstat(path),{code:'ENOENT'});await fs.promises.mkdir(path);await fs.promises.utimes(path,new Date(0),new Date(0));assert.equal(await withFileLock(path,()=>43,{staleMs:1}),43);console.log('OK');`;
 for(const mode of ['ctime','zero'])assert.match((await promisify(execFile)(process.execPath,['--input-type=module','-e',source,root,mode])).stdout,/OK/);
});

test('a lock whose owner has no valid pid is reclaimed after the grace period instead of blocking forever', async t => {
 const root = await project(t), lock = join(root, 'invalid-owner.lock');
 await mkdir(lock); await writeFile(join(lock, 'owner.json'), '{}');
 await assert.rejects(withFileLock(lock, () => assert.fail('fresh lock was reclaimed'), { timeoutMs: 100, staleMs: 60_000 }), /저장 중/);
 await utimes(lock, new Date(0), new Date(0));
 assert.equal(await withFileLock(lock, () => 'reclaimed', { timeoutMs: 2000, staleMs: 1000 }), 'reclaimed');
});

test('an old lock whose PID now belongs to a later process is reclaimed; the live owner keeps its lock', async t => {
 const root = await project(t), lock = join(root, 'reused.lock');
 for (const [at, reclaimed] of [[new Date(Date.now() + 3_600_000).toISOString(), false], ['2000-01-01T00:00:00.000Z', true]]) {
  await mkdir(lock, { recursive: true }); await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.ppid, token: randomUUID(), at }));
  await utimes(lock, new Date(0), new Date(0));
  if (reclaimed) assert.equal(await withFileLock(lock, () => 'ok', { timeoutMs: 30_000, staleMs: 1000 }), 'ok');
  else await assert.rejects(withFileLock(lock, () => assert.fail('live owner lost its lock'), { timeoutMs: 300, staleMs: 1000 }), /저장 중/);
 }
});

test('process start time is read with PowerShell on Windows unless the caller opts out', async () => {
 const { processStartedAfter } = await import('../src/file-lock.mjs');
 const at = '2026-01-01T00:00:00.000Z', marked = Date.parse(at), calls = [];
 const run = (value) => async (file, args) => { calls.push(file); return { stdout: `${value}\r\n` }; };
 assert.equal(await processStartedAfter(4242, at, { run: run(marked + 10_000), platform: 'win32' }), true);
 assert.equal(await processStartedAfter(4242, at, { run: run(marked - 10_000), platform: 'win32' }), false);
 assert.equal(await processStartedAfter(4242, at, { run: run(''), platform: 'win32' }), null, 'unknown, not reused');
 assert.equal(await processStartedAfter(4242, at, { run: async () => { throw new Error('Cannot find a process'); }, platform: 'win32' }), null);
 assert.equal(await processStartedAfter(4242, at, { run: run(marked + 10_000), platform: 'win32', windows: false }), false);
 assert.deepEqual(calls, ['powershell.exe', 'powershell.exe', 'powershell.exe']);
});

test('a feature save retries a Windows rename that an antivirus or indexer briefly blocks', async t => {
 const root = await project(t);
 const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
 Object.defineProperty(process,'platform',{value:'win32'});const original=fs.promises.rename;let attempts=0;
 fs.promises.rename=async(from,to)=>{if(to.endsWith('busy.json')&&++attempts<3)throw Object.assign(new Error('scanner holds record'),{code:'EBUSY'});return original(from,to);};syncBuiltinESMExports();
 const {createFeature,getFeature}=await import(${JSON.stringify(new URL('../src/workflow.mjs', import.meta.url).href)});
 await createFeature(process.argv[1],{id:'busy',title:'잠깐 잡힌 기록'});assert.equal(attempts,3);assert.equal((await getFeature(process.argv[1],'busy')).title,'잠깐 잡힌 기록');`;
 const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, root], { encoding: 'utf8', timeout: 8000 });
 assert.equal(child.status, 0, child.stderr || String(child.error));
});

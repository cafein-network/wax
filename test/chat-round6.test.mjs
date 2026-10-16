import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { project } from './chat-helpers.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { withFileLock } from '../src/file-lock.mjs';

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

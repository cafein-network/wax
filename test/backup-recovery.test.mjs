import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, symlink, utimes, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, at, cli } from './chat-helpers.mjs';
import { joinPresence, setPresence, listPresence } from '../src/chat/presence.mjs';
import { setPm, assignTask, updateTask } from '../src/chat/team.mjs';
import { postMessage } from '../src/chat/channels.mjs';
import { createFeature, getFeature, listFeatures, scanFeatures, updateFeature } from '../src/workflow.mjs';
import { createBackup, validateBackup, previewRestore, restoreBackup } from '../src/backup.mjs';
import { createChatServer } from '../src/chat/server.mjs';
import { fileURLToPath } from 'node:url';
import { withFileLock } from '../src/file-lock.mjs';
import { installProject as installCodex } from '../scripts/install-project.mjs';
import { ChannelFeed, ChannelDrafts } from '../web/channel-state.mjs';
const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';


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

test('backup enforces total encoded raw budget and preserves omission metadata',async t=>{
 const root=await project(t),dir=join(root,'.wax/features');await mkdir(dir,{recursive:true});await writeFile(join(dir,'a.json'),'{bad');await writeFile(join(dir,'b.json'),'{bad');await writeFile(join(dir,'c.json'),Buffer.from([255]));
 const backup=validateBackup(await createBackup(root,{rawBudget:10}));assert.equal(backup.damaged[0].raw,'{bad');assert.ok(backup.damaged.slice(1).every(x=>x.rawOmitted&&x.omittedReason==='total-limit'&&x.size>0));
 const preview=await previewRestore(root,backup);assert.equal(preview.damagedCount,3);assert.equal(preview.warnings[1].omittedReason,'total-limit');
 const raw='x'.repeat(1_000_000);assert.throws(()=>validateBackup({format:'wax-workspace',version:1,createdAt:new Date().toISOString(),features:[],damaged:Array.from({length:68},(_,i)=>({file:i+'.json',message:'bad',raw})),checksum:'invalid'}),/체크섬/);
});

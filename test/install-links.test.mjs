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


test('obsolete installer links are reported and removed, unrelated links survive',async t=>{
 const root=await project(t);await installCodex({project:root});const source=await realpath(fileURLToPath(new URL('..',import.meta.url))),path=join(root,'.agents/skills/wax-dashboard');await symlink(join(source,'skills/dashboard'),path,directoryLink);
 assert.equal((await installCodex({project:root,check:true})).ok,false);await installCodex({project:root});assert.equal((await installCodex({project:root,check:true})).ok,true);
});

test('installer detects obsolete links from previous unpack locations and reports unrelated broken wax links',async t=>{
 const root=await project(t);await installCodex({project:root});
 const dir=join(root,'.agents/skills');await symlink(join(root,'removed-source/skills/dashboard'),join(dir,'wax-dashboard'),directoryLink);
 await symlink(join(root,'missing-custom'),join(dir,'wax-custom'),directoryLink);
 const check=await installCodex({project:root,check:true});assert.deepEqual(check.obsolete.map(x=>x.name),['wax-dashboard']);assert.deepEqual(check.warnings.map(x=>x.name),['wax-custom']);
 const result=await installCodex({project:root});assert.equal(result.ok,true);assert.deepEqual(result.obsolete,[]);assert.deepEqual(result.warnings.map(x=>x.name),['wax-custom']);
});

test('installer repairs all managed dangling links while keeping unrelated user links',async t=>{
 const {rm,lstat}=await import('node:fs/promises');const root=await project(t),first=await installCodex({project:root});
 for(const item of first.skills){await rm(item.path);await symlink(join(root,'deleted-source',item.name),item.path,directoryLink);}
 const custom=join(root,'.agents/skills/wax-custom');await symlink(join(root,'user-missing'),custom,directoryLink);const check=await installCodex({project:root,check:true});assert.equal(check.skills.filter(x=>x.status==='stale').length,26);
 const repaired=await installCodex({project:root});assert.equal(repaired.ok,true);assert.equal(repaired.warnings[0].name,'wax-custom');assert.ok((await lstat(custom)).isSymbolicLink());assert.equal((await installCodex({project:root,check:true})).ok,true);
});

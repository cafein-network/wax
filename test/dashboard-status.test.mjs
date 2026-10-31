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


test('dashboard status recognizes real and symlink project paths',async t=>{
 const {createChatServer}=await import('../src/chat/server.mjs');const {run}=await import('../src/chat/cli.mjs');const {once}=await import('node:events');
 const root=await project(t),alias=join(root,'project-alias');await symlink(root,alias,directoryLink);const server=createChatServer({root});t.after(()=>server.shutdown());server.listen(0,'127.0.0.1');await once(server,'listening');
 let output='';const code=await run(['serve','--status','--port',String(server.address().port),'--json'],{cwd:alias,env:{},stdout:{write(value){output+=value}}});assert.equal(code,0);assert.equal(JSON.parse(output).running,true);
});

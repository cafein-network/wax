import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolNews, NEWS_INTERVAL_MS, parseToolRelease } from '../src/chat/tool-news.mjs';
import { CLI_NEWS } from '../web/office/cli-news.mjs';
import { npcGuide } from '../web/office/chatter.mjs';
const cliHTML = (version) => `<article id="rel-app-9.9.9"><li>Wrong app</li></article><article id="rel-cli-${version}"><time datetime="2026-10-16"></time><li>New CLI feature</li></article>`;
const fixtures = Object.fromEntries(Object.entries(CLI_NEWS.tools).map(([kind, info]) => [kind, kind === 'antigravity' ? cliHTML(info.latest) : JSON.stringify({ tag_name: `${kind === 'codex' ? 'rust-v' : 'v'}${info.latest}`, body: '- Official feature\n- Another fix', published_at: '2026-10-16T00:00:00Z', draft: false, prerelease: false })]));
const kindOf = (url) => url.includes('anthropics') ? 'claude' : url.includes('openai') ? 'codex' : url.includes('copilot') ? 'copilot' : url.includes('gemini-cli') ? 'gemini' : 'antigravity';

test('release parser selects stable CLI releases and rejects prerelease or missing notes',()=>{
 for(const [kind,body] of Object.entries(fixtures)) assert.equal(parseToolRelease(kind,body).latest,CLI_NEWS.tools[kind].latest);
 assert.throws(()=>parseToolRelease('codex',JSON.stringify({tag_name:'rust-v0.164.0-alpha.1',body:'- test',published_at:'2026-10-16'})));
 assert.throws(()=>parseToolRelease('claude',JSON.stringify({tag_name:'v2.1.302',body:'',published_at:'2026-10-16'})));
 assert.equal(parseToolRelease('antigravity',cliHTML('1.3.7')).latest,'1.3.7');
});

test('official release checks coalesce, cache one hour, refresh on demand and keep last good data on failure',async()=>{
 let time=Date.parse('2026-10-16T00:00:00Z'),calls=0,fail=false;
 const feed=createToolNews({clock:()=>time,fetch:async url=>{calls++;await new Promise(resolve=>setImmediate(resolve));if(fail)throw Error('offline');return new Response(fixtures[kindOf(url)]);}});
 const [a,b]=await Promise.all([feed(),feed()]);assert.equal(calls,5);assert.deepEqual(a,b);assert.ok(Object.values(a.tools).every(x=>x.checkStatus==='ok'&&x.verifiedAt));
 time+=NEWS_INTERVAL_MS-1;await feed();assert.equal(calls,5);
 time+=2;await feed();assert.equal(calls,10);
 fail=true;const failed=await feed({fresh:true});assert.equal(calls,15);assert.ok(Object.values(failed.tools).every(x=>x.checkStatus==='unavailable'&&x.verifiedAt));assert.equal(failed.tools.claude.latest,a.tools.claude.latest);
 time+=299_999;await feed();assert.equal(calls,15);time+=2;await feed();assert.equal(calls,20);
 assert.equal((await feed({enabled:false})).mode,'bundled');assert.equal(calls,20,'offline mode never sends a request');
});

test('new release replaces bundled headlines, labels original notes and never sends local identity',async()=>{
 const seen=[];
 const feed=createToolNews({fetch:async(url,options)=>{seen.push({url,options});const kind=kindOf(url);return new Response(kind==='claude'?JSON.stringify({tag_name:'v2.1.302',body:'- New live feature',published_at:'2026-10-16T01:00:00Z'}):fixtures[kind]);}});
 const news=await feed();assert.equal(news.tools.claude.latest,'2.1.302');assert.equal(news.tools.claude.items[0].original,true);
 assert.ok(seen.every(({url,options})=>url.startsWith('https://')&&!options.body&&options.redirect==='error'));
 const guide=npcGuide('tools',{toolNews:news,tools:[{kind:'claude',installed:true,version:'2.1.301'}]});
 assert.match(guide.sections[0].items[0],/새 버전 2.1.302/);assert.ok(guide.sections.some(x=>x.items.some(item=>/공식 원문.*New live feature/.test(item))));assert.ok(guide.sections.some(x=>x.heading==='소식 확인'));
});

test('older or malformed upstream releases never replace newer reviewed data',async()=>{
 const feed=createToolNews({fetch:async()=>new Response(JSON.stringify({tag_name:'v0.0.1',body:'- Old entry',published_at:'2025-01-01'}))});
 const news=await feed();for(const kind of Object.keys(fixtures)){assert.equal(news.tools[kind].latest,CLI_NEWS.tools[kind].latest);assert.equal(news.tools[kind].checkStatus,'unavailable');}
});

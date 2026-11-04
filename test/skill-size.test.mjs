import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, readBudget, overBudget } from '../scripts/skill-size.mjs';

test('generated commands and skills stay within their byte budget', async () => {
  const files = await measure();
  const budget = await readBudget();
  assert.equal(files.length, Object.keys(budget.files).length, 'scripts/skill-budget.json must list every generated file; run node scripts/skill-size.mjs --update-budget');
  const result = overBudget(files, budget);
  const lines = result.files.map((file) => `  ${file.path}: ${file.bytes} bytes > budget ${file.budget} (largest sections: ${file.sections.slice(0, 3).map((s) => `${s.name} ${s.bytes}`).join(', ')})`);
  if (result.totalOver) lines.push(`  total: ${result.total} bytes > budget ${result.totalBudget}`);
  assert.equal(lines.length, 0, `Generated wax commands or skills exceed their size budget:\n${lines.join('\n')}\nTrim the text in scripts/build-commands.mjs (npm run size:skills lists the largest shared sections), or raise the budget deliberately as scripts/skill-budget.json describes.`);
});

test('the size check reports offending files with their budget and largest sections', () => {
  const files = [{ path: 'commands/x.md', bytes: 120, sections: [{ name: 'team:claude', bytes: 80 }, { name: 'common', bytes: 40 }] }, { path: 'commands/y.md', bytes: 50, sections: [] }];
  const result = overBudget(files, { total: 160, files: { 'commands/x.md': 100, 'commands/y.md': 60 } });
  assert.deepEqual(result.files.map((file) => [file.path, file.bytes, file.budget, file.sections[0].name]), [['commands/x.md', 120, 100, 'team:claude']]);
  assert.equal(result.totalOver, true);
  assert.equal(result.total, 170);
});

test('MCP-first work guidance is at least 30% smaller than the CLI guidance and keeps a CLI fallback', async () => {
  const { render } = await import('../scripts/build-commands.mjs');
  const cli = render({ mcp: false }), mcp = render();
  const size = (files, path) => Buffer.byteLength(files.find((file) => file.path === path).content);
  const text = (files, path) => files.find((file) => file.path === path).content;
  for (const path of ['commands/work.md', 'commands/wax/work.toml']) {
    const before = size(cli, path), after = size(mcp, path);
    assert.ok(after <= before * 0.7, `${path}: ${after} bytes is not 30% below the CLI guidance (${before} bytes)`);
  }
  for (const file of mcp.filter((item) => /^commands\//.test(item.path))) {
    assert.match(file.content, /when wax_join is in your tool list/, file.path);
    assert.match(file.content, /Tools missing \(the server is opt-in with WAX_MCP=on\): use the CLI\. Join once with CLI chat join --json/, `${file.path} keeps the CLI fallback`);
    assert.match(file.content, /CLI chat task accept\|done\|block <task-id> --author <name> --session <saved-session-id>/, file.path);
  }
  for (const file of mcp.filter((item) => /^skills\/.*SKILL\.md$/.test(item.path))) {
    assert.equal(file.content, text(cli, file.path), `${file.path}: Codex, Copilot CLI, Antigravity CLI and Grok Build keep the CLI guidance`);
    assert.doesNotMatch(file.content, /wax_join/, file.path);
  }
});

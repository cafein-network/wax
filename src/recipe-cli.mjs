import { t } from '../web/messages-catalog.mjs';
import { lstat, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { RECIPE_LIMITS, listRecipes, parseRecipe } from './recipes.mjs';
import { cliText } from './cli-locale.mjs';

export async function recipeCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const root = resolve(values.project || process.cwd());
  const { say, localize } = cliText();
  const [command, target] = positionals;
  if (values.help || !command) { console.log(say('cli.recipe.help')); return; }
  const where = (name) => say(`recipes.source.${['local', 'shared', 'builtin'].includes(name) ? name : 'builtin'}`);
  const source = (entry) => where(entry.source);
  const approval = (entry) => (entry.source === 'shared' && entry.approval ? `  [${say(`recipes.approval.${entry.approval.state}`)}]` : '');
  const state = (entry) => `${!entry.usable ? say('recipes.unusable') : entry.shadowedBy ? say('cli.recipe.shadowed', where(entry.shadowedBy)) : say('cli.recipe.usable')}${approval(entry)}`;
  if (command === 'list') {
    if (positionals.length !== 1) throw new Error(t('errors.recipeCli.usage'));
    const overview = await listRecipes(root);
    if (values.json) { console.log(JSON.stringify(overview, null, 2)); return; }
    if (!overview.recipes.length) { console.log(say('recipes.empty')); return; }
    for (const entry of overview.recipes) {
      console.log(`${entry.id}  [${source(entry)}]  [${state(entry)}]  ${entry.recipe ? localize(entry.recipe.title) : entry.file}${entry.recipe?.mode === 'auto' ? `  ${say('cli.recipe.autoRecommended')}` : ''}`);
      if (!entry.usable) console.log(`  ${localize(entry.reason)}`);
    }
    for (const [name, count] of Object.entries(overview.skipped)) if (count) console.log(say('cli.recipe.skipped', count, where(name), RECIPE_LIMITS.count));
    for (const issue of overview.issues) console.log(localize(issue));
    return;
  }
  if (command === 'show') {
    if (positionals.length !== 2) throw new Error(t('errors.recipeCli.usage'));
    const entries = (await listRecipes(root)).recipes.filter((entry) => entry.id === target);
    if (!entries.length) throw new Error(t('errors.recipes.notFound', target));
    if (values.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    for (const entry of entries) {
      console.log(`${entry.id}  [${source(entry)}]  [${state(entry)}]  ${entry.file}${entry.hash ? `  sha256:${entry.hash.slice(0, 12)}` : ''}`);
      if (entry.approval?.by && entry.approval.state === 'approved') console.log(`  ${say('cli.recipe.approvedBy', entry.approval.by, entry.approval.at)}`);
      if (!entry.usable) { console.log(`  ${localize(entry.reason)}`); continue; }
      const recipe = entry.recipe;
      console.log(`  ${localize(recipe.title)}${recipe.description ? ` — ${localize(recipe.description)}` : ''}`);
      console.log(`  ${say('cli.recipe.input', localize(recipe.input.label))}`);
      console.log(`  ${say('cli.recipe.goal', localize(recipe.goal))}`);
      if (recipe.input.details) console.log(`  ${say('cli.recipe.details', localize(recipe.input.details.label))}`);
      for (const task of recipe.tasks) {
        console.log(`  ${task.id}  ${localize(task.title)}`);
        if (task.description) console.log(`    ${say('cli.recipe.description', task.description)}`);
        task.ac.forEach((item, n) => console.log(`    AC-${n + 1}: ${localize(item)}`));
      }
      const workers = Object.entries(recipe.workers).map(([phase, tool]) => `${phase}=${tool}`).join(', ');
      console.log(`  ${say('cli.recipe.workers', workers || say('recipes.defaultOrder'))}`);
      console.log(`  ${say('cli.recipe.judgeTool', recipe.judgeTool ?? say('recipes.defaultOrder'))}`);
      console.log(`  ${say('cli.recipe.budgets', Object.entries(recipe.budgets).map(([name, value]) => `${name}=${value}`).join(', ') || say('cli.recipe.defaults'))}`);
      console.log(`  ${say('cli.recipe.mode', recipe.mode)}${recipe.mode === 'auto' ? `  ${say('cli.recipe.autoRecommended')}` : ''}`);
      for (const [phase, note] of Object.entries(recipe.notes)) console.log(`  ${say('cli.recipe.note', phase, localize(note))}`);
      if (recipe.allow?.length) console.log(`  ${say('cli.recipe.allow', recipe.allow.join(', '))}`);
    }
    return;
  }
  if (command === 'check') {
    if (positionals.length > 2) throw new Error(t('errors.recipeCli.usage'));
    if (target) {
      const path = resolve(target);
      let text;
      try {
        const info = await lstat(path);
        if (!info.isFile()) throw Object.assign(new Error(), { code: 'ENOTFILE' });
        if (info.size > RECIPE_LIMITS.file) text = null;
        else text = await readFile(path, 'utf8');
      } catch (error) { throw new Error(t('errors.recipeCli.couldNotRead', target, error.code ?? error.message)); }
      const checked = text === null ? { ok: false, reason: t('recipes.check.tooLarge', RECIPE_LIMITS.file / 1024) } : parseRecipe(text);
      if (values.json) console.log(JSON.stringify(checked, null, 2));
      else console.log(checked.ok ? say('cli.recipe.checkOk', target, checked.recipe.id) : say('cli.recipe.checkFailed', target, localize(checked.reason)));
      if (!checked.ok) process.exitCode = 1;
      return;
    }
    const { recipes } = await listRecipes(root);
    const broken = recipes.filter((entry) => !entry.usable);
    const shared = recipes.filter((entry) => entry.source === 'shared');
    const waiting = shared.filter((entry) => entry.usable && entry.approval?.state !== 'approved');
    if (values.json) {
      console.log(JSON.stringify({ ok: !broken.length, checked: recipes.length, unusable: broken.map(({ id, source: from, file, reason }) => ({ id, source: from, file, reason })),
        shared: shared.map(({ id, file, hash, usable, approval: state }) => ({ id, file, hash: hash ?? null, usable, approval: state?.state ?? null })) }, null, 2));
    } else {
      console.log(say('cli.recipe.checkAll', recipes.length, broken.length));
      for (const entry of broken) console.log(`  ${entry.file}: ${localize(entry.reason)}`);
      if (shared.length) {
        console.log(say('cli.recipe.checkShared', shared.length, waiting.length));
        for (const entry of shared.filter((item) => item.usable)) console.log(`  ${entry.file}: ${say(`recipes.approval.${entry.approval.state}`)}`);
      }
    }
    if (broken.length) process.exitCode = 1;
    return;
  }
  throw new Error(t('errors.recipeCli.usage'));
}

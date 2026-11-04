import { t } from '../web/messages-catalog.mjs';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fireLocal, previewTrigger, triggerOverview } from './chat/triggers.mjs';
import { cliText } from './cli-locale.mjs';

async function payloadOption(path) {
  if (path === undefined) return undefined;
  try { return await readFile(resolve(path), 'utf8'); }
  catch (error) { throw new Error(t('errors.triggerCli.couldNotReadPayload', path, error.code ?? error.message)); }
}

export async function triggerCli(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, payload: { type: 'string' }, key: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const root = resolve(values.project || process.cwd());
  const { say, localize } = cliText();
  const [command, id] = positionals;
  if (values.help || !command) { console.log(say('cli.trigger.help')); return; }
  if (command === 'list') {
    if (positionals.length !== 1) throw new Error(t('errors.triggerCli.usage'));
    const overview = await triggerOverview(root);
    if (values.json) { console.log(JSON.stringify(overview, null, 2)); return; }
    if (!overview.triggers.length) { console.log(say('cli.trigger.none')); return; }
    console.log(say('cli.trigger.usage', overview.proposedToday, overview.dailyCap));
    for (const trigger of overview.triggers) {
      console.log(`${trigger.id}  ${say(trigger.enabled ? 'cli.trigger.on' : 'cli.trigger.off')}  ${trigger.name}  · ${trigger.source.type}: ${trigger.describe} · ${trigger.action.kind}`);
      if (trigger.nextRun) console.log(`  ${say('cli.trigger.next', trigger.nextRun)}`);
      if (trigger.poll?.nextPoll) console.log(`  ${say('cli.trigger.nextPoll', trigger.poll.nextPoll)}`);
      if (trigger.enabled && trigger.poll?.reason) console.log(`  ${say('cli.trigger.connection')}: ${localize(trigger.poll.reason)}`);
      if (trigger.disabledReason) console.log(`  ${localize(trigger.disabledReason)}`);
      else if (trigger.state.lastError) console.log(`  ${say('cli.trigger.lastError', trigger.state.failures ?? 0, localize(trigger.state.lastError))}`);
    }
    return;
  }
  if (!['test', 'fire'].includes(command) || positionals.length !== 2) throw new Error(t('errors.triggerCli.usage'));
  const input = { payload: await payloadOption(values.payload), key: values.key };
  const result = command === 'test' ? await previewTrigger(root, id, input) : await fireLocal(root, id, input);
  if (values.json) { console.log(JSON.stringify(result, null, 2)); return; }
  const outcome = say({ proposed: 'cli.trigger.proposed', notified: 'cli.trigger.notified', skipped: 'cli.trigger.skipped', limited: 'cli.trigger.limited',
    baseline: 'cli.trigger.baseline', none: 'cli.trigger.nothing', connection: 'cli.trigger.connection' }[result.outcome]);
  console.log(command === 'test' ? say('cli.trigger.preview', outcome) : outcome);
  if (result.reason) console.log(`  ${localize(result.reason)}`);
  if (result.polled && result.found !== undefined) console.log(`  ${say('cli.trigger.found', result.found, result.fresh)}`);
  const text = result.notice ?? result.proposal?.text;
  if (text) console.log(`  ${say('cli.trigger.text', text)}`);
  if (result.proposal?.quoted && command === 'test') console.log(`  ${say('cli.trigger.quoted', result.proposal.quoted.length)}`);
  if (command === 'fire' && result.outcome === 'proposed') console.log(`  ${say('cli.trigger.accept')}`);
  if (['limited', 'skipped'].includes(result.outcome) && command === 'fire') process.exitCode = 3;
}

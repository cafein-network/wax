import { t } from './messages-catalog.mjs';
import { api, el } from '/dom.mjs';
import { COMMANDS, TOOLS, commandFor } from '/commands.mjs';

const fill = (key, text) => { for (const node of document.querySelectorAll(`[data-fill="${key}"]`)) node.textContent = text; };
fill('origin', `${location.origin}/`);
fill('feature-url', `${location.origin}/?feature=chatbot`);
fill('project-channel', t('help.projectName'));
try {
  const config = await api('/api/config');
  document.title = t('help.waxHelp', config.project);
  fill('project', config.project);
  fill('project-channel', `# ${config.project}`);
} catch {   }

const table = document.getElementById('tool-commands');
if (table) {
  const example = (c) => (c.args.startsWith('<작업ID>') ? 'login' : '');
  const head = el('tr', {}, el('th', { scope: 'col', text: t('help.command') }), TOOLS.map((tool) => el('th', { scope: 'col', text: tool.label })));
  const rows = COMMANDS.map((c) => el('tr', {},
    el('th', { scope: 'row' }, el('span', { text: c.label }), el('br'), el('span', { class: 'kind', text: c.args ? `${c.name} ${c.args}` : c.name })),
    TOOLS.map((tool) => el('td', {}, el('code', { text: commandFor(tool.kind, c.name, example(c)) })))));
  table.append(el('thead', {}, head), el('tbody', {}, rows));
}

import { t } from '../messages-catalog.mjs';
export const CLI_NEWS = {
  asOf: '2026-10-16',
  tools: {
    claude: {
      latest: '2.1.301', update: 'claude update', source: 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
      items: [
        { version: '2.1.301', text: t('office.cliNews.theModeComposerSupports') },
        { version: '2.1.301', text: t('office.cliNews.improvedProtectionForUnpushed') },
      ],
    },
    codex: {
      latest: '0.163.0', update: 'npm install -g @openai/codex@latest', source: 'https://github.com/openai/codex/releases',
      items: [
        { version: '0.163.0', text: t('office.cliNews.searchAndChangeSettings') },
        { version: '0.163.0', text: t('office.cliNews.chooseALeaderKey') },
      ],
    },
    copilot: {
      latest: '1.0.98', update: 'copilot update', source: 'https://github.com/github/copilot-cli/releases',
      items: [
        { version: '1.0.98', text: t('office.cliNews.addedGemini4Argon') },
        { version: '1.0.98', text: t('office.cliNews.expandOrCopyFull') },
      ],
    },
    gemini: {
      latest: '0.64.0', update: 'npm install -g @google/gemini-cli@latest', source: 'https://github.com/google-gemini/gemini-cli/releases',
      items: [
        { version: '0.64.0', text: t('office.cliNews.atomicFileWritesAnd') },
        { version: '0.64.0', text: t('office.cliNews.theAcpBridgeReports') },
      ],
    },
    antigravity: {
      latest: '1.3.6', update: 'agy update', source: 'https://antigravity.google/docs/changelog/',
      items: [
        { version: '1.3.6', text: t('office.cliNews.claude55Support') },
        { version: '1.3.6', text: t('office.cliNews.automaticCancellationAndRetry') },
      ],
    },
  },
};

export function newerThan(a, b) {
  const parts = (v) => String(v ?? '').split(/[.+-]/).map((n) => Number.parseInt(n, 10));
  const x = parts(a), y = parts(b);
  if (x.some(Number.isNaN) || y.slice(0, 2).some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

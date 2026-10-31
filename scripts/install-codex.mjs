#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstaller } from './install-project.mjs';

export { installProject as installCodex } from './install-project.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runInstaller('scripts/install-codex.mjs');

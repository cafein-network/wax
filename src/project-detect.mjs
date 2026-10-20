import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const WEB_PACKAGES = new Set(['next', 'react', 'react-dom', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'vite', 'astro', '@angular/core', 'solid-js', 'gatsby', '@remix-run/react', '@playwright/test']);

export async function detectProjectType(root) {
  try {
    const file = join(root, 'package.json');
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    const names = [pkg?.dependencies, pkg?.devDependencies].flatMap((deps) => deps && typeof deps === 'object' && !Array.isArray(deps) ? Object.keys(deps) : []);
    return names.some((name) => WEB_PACKAGES.has(name)) ? 'web' : null;
  } catch { return null; }
}

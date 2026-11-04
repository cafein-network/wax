import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const WEB_PACKAGES = new Set(['next', 'react', 'react-dom', 'vue', 'nuxt', 'svelte', '@sveltejs/kit', 'vite', 'astro', '@angular/core', 'solid-js', 'gatsby', '@remix-run/react', '@playwright/test']);
const NATIVE_PACKAGES = new Set(['react-native', 'expo', 'electron', '@tauri-apps/api', '@tauri-apps/cli']);
const MAX_WORKSPACES = 50;

async function readPackage(dir) {
  try {
    const file = join(dir, 'package.json');
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    return pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg : null;
  } catch { return null; }
}

function packageKind(pkg) {
  const names = [pkg.dependencies, pkg.devDependencies].flatMap((deps) => deps && typeof deps === 'object' && !Array.isArray(deps) ? Object.keys(deps) : []);
  if (names.some((name) => NATIVE_PACKAGES.has(name))) return 'native';
  return names.some((name) => WEB_PACKAGES.has(name)) ? 'web' : null;
}

async function workspacePatterns(root, pkg) {
  const listed = Array.isArray(pkg?.workspaces) ? pkg.workspaces : Array.isArray(pkg?.workspaces?.packages) ? pkg.workspaces.packages : [];
  let pnpm = [];
  try {
    const text = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
    pnpm = [...text.matchAll(/^\s*-\s*['"]?([^'"#\s]+)['"]?\s*$/gm)].map((match) => match[1]);
  } catch {}
  return [...listed, ...pnpm].filter((pattern) => typeof pattern === 'string' && !pattern.startsWith('!') && !pattern.split('/').includes('..'));
}

async function workspaceDirs(root, patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!clean.endsWith('/*') && !clean.includes('*')) { dirs.push(join(root, clean)); continue; }
    if (!clean.endsWith('/*') || clean.slice(0, -2).includes('*')) continue;
    try {
      const parent = join(root, clean.slice(0, -2));
      for (const entry of await readdir(parent, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') dirs.push(join(parent, entry.name));
    } catch {}
    if (dirs.length >= MAX_WORKSPACES) break;
  }
  return dirs.slice(0, MAX_WORKSPACES);
}

export async function detectProjectType(root) {
  try {
    const pkg = await readPackage(root);
    if (pkg && packageKind(pkg) === 'web') return 'web';
    for (const dir of await workspaceDirs(root, await workspacePatterns(root, pkg))) {
      const child = await readPackage(dir);
      if (child && packageKind(child) === 'web') return 'web';
    }
    return null;
  } catch { return null; }
}

import hashlib
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib
import unittest
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', ROOT / 'scripts/package-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

FULL = os.environ.get('WAX_PACKAGE_FULL', '1') != '0'
slow = unittest.skipUnless(FULL, 'WAX_PACKAGE_FULL=0: 이 변경은 배포 목록·포장·사무실 그림에 닿지 않는다')


class ReleaseTests(unittest.TestCase):
    def test_only_current_release_notes_are_published_and_match_the_version(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            changelog = source / 'CHANGELOG.md'
            changelog.write_text('# History\n\n## 1.2.3 — 2026-10-17 <!-- Internal date memo. -->\n\n- Current fix.\n<!-- Internal memo. -->\n\n## 1.2.2 — 2026-10-16\n\nPrivate historical detail.', encoding='utf-8')
            notes = release.release_notes(source, '1.2.3')
            self.assertEqual(notes, '# wax 1.2.3 — 2026-10-17\n\n- Current fix.\n')
            self.assertEqual(release.release_notes(source, '1.2.2'), '# wax 1.2.2 — 2026-10-16\n\nPrivate historical detail.\n')
            with self.assertRaisesRegex(ValueError, 'CHANGELOG.md'):
                release.release_notes(source, '1.2.4')
            changelog.write_text('# History\n\n## 1.2.5 — 2026-10-19\n\n- Newest.\n\n## 1.2.4 — 2026-10-18\n\n- Unpublished.\n\n## 1.2.3 — 2026-10-17\n\n- Published.\n', encoding='utf-8')
            self.assertEqual(release.release_notes(source, '1.2.5', '1.2.3'), '# wax 1.2.5 — 2026-10-19\n\n- Newest.\n\n## 1.2.4 — 2026-10-18\n\n- Unpublished.\n')
            self.assertEqual(release.release_notes(source, '1.2.5'), '# wax 1.2.5 — 2026-10-19\n\n- Newest.\n')
            for since in ('1.2.5', '2.0.0', 'x'):
                with self.subTest(since=since), self.assertRaisesRegex(ValueError, 'notes-since'):
                    release.release_notes(source, '1.2.5', since)
            changelog.unlink()
            (source / 'RELEASE_NOTES.md').write_bytes(notes.replace('\n', '\r\n').encode('utf-8'))
            self.assertEqual(release.release_notes(source, '1.2.3'), notes)
            with self.assertRaisesRegex(ValueError, 'match the release version'):
                release.release_notes(source, '1.2.4')
            for content, message in [('# wax 1.2.3', 'contain changes'), ('# wax 1.2.3\n<!-- internal -->', 'contain changes'), ('# wax 1.2.3\n<!-- internal', 'unterminated'), ('# wax 1.2.3\nsk-' + 'a' * 30, 'possible secret')]:
                (source / 'RELEASE_NOTES.md').write_text(content, encoding='utf-8')
                with self.subTest(content=message), self.assertRaisesRegex(ValueError, message):
                    release.release_notes(source, '1.2.3')
            (source / 'RELEASE_NOTES.md').unlink()
            with self.assertRaisesRegex(ValueError, 'complete release archive'):
                release.release_notes(source, '1.2.3')

    def test_workflow_files_are_published_with_lf_from_a_crlf_checkout(self):
        with tempfile.TemporaryDirectory() as temp:
            workflow = Path(temp) / 'public.yml'
            workflow.write_bytes(b'# Kept comment\r\nname: checks\r\n')
            self.assertEqual(release.release_bytes(workflow), b'# Kept comment\nname: checks\n')

    def test_package_exports_are_published(self):
        exports = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['exports']
        self.assertIn('./rules', exports)
        for name, target in exports.items():
            with self.subTest(name=name):
                self.assertIn(target.removeprefix('./'), release.FILES)

    def test_ai_memory_and_agent_instruction_files_never_ship(self):
        self.assertEqual(release.ai_memory_files(release.FILES), [])
        source_tree = (ROOT / 'scripts' / 'publish-marketplace.py').exists()
        for name in ('CLAUDE.md', 'docs/HANDOFF.md', 'docs/DELEGATION.md'):
            with self.subTest(name=name):
                if source_tree:
                    self.assertTrue((ROOT / name).exists(), name)
                self.assertNotIn(name, release.FILES)
        caught = ['CLAUDE.md', 'sub/CLAUDE.local.md', 'AGENTS.md', 'skills/x/AGENTS.override.md', 'docs/HANDOFF.md',
                  'docs/handoff-0.15.md', 'docs/DELEGATION.md', 'MEMORY.md', 'docs/MEMORY_REVIEW.md', '.claude/settings.json', '.codex/config.toml',
                  '.gemini/settings.json', '.cursor/rules/a.mdc', '.cursorrules', '.github/copilot-instructions.md']
        kept = ['GEMINI.md', 'gemini-extension.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
                '.agents/plugins/marketplace.json', 'claude-mods/hooks.json', 'docs/USER_GUIDE.md', 'skills/memory/SKILL.md']
        self.assertEqual(release.ai_memory_files(caught), sorted(caught))
        self.assertEqual(release.ai_memory_files(kept), [])

    def test_private_ci_scope_never_ships(self):
        for name in ('scripts/ci-scope.mjs', 'test/ci-scope.test.mjs', '.gitea/workflows/ci.yml'):
            self.assertNotIn(name, release.FILES)

    def test_pressure_eval_never_ships(self):
        names = ['scripts/pressure-eval.mjs', 'scripts/pressure-judge.mjs', 'scripts/pressure-edits.mjs', 'test/pressure-eval.test.mjs', 'test/pressure-eval-run.test.mjs',
                 'test/pressure-eval-edits.test.mjs', 'test/pressure-eval-ledger.test.mjs',
                 *(path.relative_to(ROOT).as_posix() for path in (ROOT / 'test' / 'eval').rglob('*') if path.is_file())]
        for name in names:
            self.assertNotIn(name, release.FILES)

    @slow
    def test_reproducible_archive_extracts_and_runs_without_install(self):
        with tempfile.TemporaryDirectory(prefix='wax release ') as temp:
            work = Path(temp)
            first = release.build_release(ROOT, work / 'a')
            second = release.build_release(ROOT, work / 'b')
            self.assertEqual(first, second)
            archive = work / 'a' / first['filename']
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), first['sha256'])
            with zipfile.ZipFile(archive) as zipped:
                self.assertIsNone(zipped.testzip())
                self.assertEqual(set(zipped.namelist()), {f'wax/{name}' for name in (*release.FILES, 'RELEASE_NOTES.md')})
                zipped.extractall(work / 'extracted')
            plugin = work / 'extracted/wax'
            codex_catalog = json.loads((plugin / '.agents/plugins/marketplace.json').read_text(encoding='utf-8'))
            self.assertEqual(codex_catalog['name'], 'wax')
            self.assertEqual(codex_catalog['plugins'][0]['source'], {'source': 'local', 'path': './'})
            self.assertTrue((plugin / '.codex-plugin/plugin.json').is_file())
            notes = (plugin / 'RELEASE_NOTES.md').read_text(encoding='utf-8')
            self.assertTrue(notes.startswith(f'# wax {first["version"]}'))
            current = tuple(int(part) for part in first['version'].split('.'))
            for heading in re.findall(r'^## .*$', notes, re.MULTILINE):
                joined = re.fullmatch(r'## (\d+)\.(\d+)\.(\d+) — .+', heading)
                self.assertTrue(joined and tuple(int(part) for part in joined.groups()) < current, heading)
            self.assertEqual(notes, (work / 'a/RELEASE_NOTES.md').read_text(encoding='utf-8'))
            repacked = release.build_release(plugin, work / 'repacked')
            self.assertEqual(repacked, first)
            for command in (plugin / 'commands/wax').glob('*.toml'):
                tomllib.loads(command.read_text(encoding='utf-8'))
            subprocess.run([shutil.which('npm') or 'npm', 'run', 'check'], cwd=plugin, check=True, capture_output=True)
            try:
                checked = subprocess.run(['node', '--test', '--test-timeout=60000', '--import', './test/korean-output.mjs'], cwd=plugin, capture_output=True, encoding='utf-8', timeout=180)
            except subprocess.TimeoutExpired as error:
                partial = (error.stdout or b'')
                partial = partial.decode('utf-8', 'replace') if isinstance(partial, bytes) else partial
                self.fail('extracted tests did not finish in 180 s; last output:\n' + partial[-3000:])
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            cli = plugin / 'bin/wax.mjs'
            target = work / 'target project'
            created = subprocess.check_output(['node', str(cli), 'start', 'zip-test', '--project', str(target)], encoding='utf-8')
            self.assertEqual(json.loads(created)['phase'], 'plan')
            saved = subprocess.check_output(['node', str(cli), 'status', 'zip-test', '--project', str(target)], encoding='utf-8')
            self.assertEqual(json.loads(saved)['id'], 'zip-test')
            self.assertFalse((plugin / '.wax').exists())

    @slow
    def test_office_art_ships_as_webp_and_every_reference_resolves(self):
        with tempfile.TemporaryDirectory(prefix='wax release ') as temp:
            metadata = release.build_release(ROOT, Path(temp) / 'out')
            self.assertLess(metadata['bytes'], 8 * 1024 * 1024)
            with zipfile.ZipFile(Path(temp) / 'out' / metadata['filename']) as zipped:
                names = set(zipped.namelist())
                side = sorted(name for name in names if name.startswith('wax/' + release.SIDE))
                self.assertFalse([name for name in side if name.endswith('.png')])
                manifest = json.loads(zipped.read('wax/' + release.SIDE + 'manifest.json'))
                files = [*manifest['backgrounds'].values(), *(info['file'] for info in manifest['props'].values())]
                for entry in manifest['characters'].values():
                    for info in [*entry['views'].values(), *entry.get('poses', {}).values()]:
                        files += [info['file'], *([info['mask']] if info.get('mask') else [])]
                for file in files:
                    self.assertTrue(file.endswith('.webp'), file)
                    self.assertIn('wax/' + release.SIDE + file, names)
                self.assertIn('faces.webp', zipped.read('wax/web/office/faces.mjs').decode('utf-8'))
                self.assertNotRegex(zipped.read('wax/web/office/faces.mjs').decode('utf-8'), r'faces\.png')
                for name in side:
                    if not name.endswith('.webp'):
                        continue
                    data = zipped.read(name)
                    self.assertEqual((data[:4], data[8:12]), (b'RIFF', b'WEBP'), name)
                    lossless = name.endswith('/faces.webp') or name.endswith('-mask.webp')
                    self.assertEqual(b'VP8L' in data[12:40], lossless, name)
                    source = ROOT / (name.removeprefix('wax/')[:-5] + '.png')
                    if lossless and source.exists():
                        try:
                            from PIL import Image
                        except ImportError:
                            continue
                        with Image.open(source) as original, Image.open(io.BytesIO(data)) as shipped:
                            self.assertEqual(original.convert('RGBA').tobytes(), shipped.convert('RGBA').tobytes(), name)

    def test_private_files_excluded_and_symlink_sources_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            source = work / 'source'
            private_data = str(uuid.uuid4())
            for name in release.FILES:
                name = release.source_name(ROOT, name)
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            version = json.loads((source / 'package.json').read_text(encoding='utf-8'))['version']
            (source / 'RELEASE_NOTES.md').write_text(release.release_notes(ROOT, version), encoding='utf-8')
            for name in ['.env', '.git/config', '.wax/features/private.json', 'docs/private.md', 'node_modules/private.txt']:
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(private_data)
            release.build_release(source, work / 'output')
            with zipfile.ZipFile(work / 'output/wax-latest.zip') as archive:
                self.assertFalse(any(private_data.encode() in archive.read(name) for name in archive.namelist()))
            with self.subTest('a secret pasted into any shipped text file stops the release'):
                readme = (source / 'README.md').read_text(encoding='utf-8')
                (source / 'README.md').write_text(readme + '\ntoken: ghp_' + 'a' * 36 + '\n', encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'possible secret: README.md'):
                    release.build_release(source, work / 'output')
                (source / 'README.md').write_text(readme, encoding='utf-8')
            with self.subTest('file symlink protection'):
                (source / 'LICENSE').unlink()
                try:
                    (source / 'LICENSE').symlink_to(source / '.env')
                except OSError as error:
                    if getattr(error, 'winerror', None) == 1314:
                        self.skipTest('Windows file symlink privilege is unavailable')
                    raise
                with self.assertRaisesRegex(ValueError, 'symlinks'):
                    release.build_release(source, work / 'output')


if __name__ == '__main__':
    unittest.main()

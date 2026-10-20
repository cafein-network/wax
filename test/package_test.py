import hashlib
import importlib.util
import json
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
            self.assertNotIn('\n## ', notes)
            self.assertEqual(notes, (work / 'a/RELEASE_NOTES.md').read_text(encoding='utf-8'))
            repacked = release.build_release(plugin, work / 'repacked')
            self.assertEqual(repacked, first)
            for command in (plugin / 'commands/wax').glob('*.toml'):
                tomllib.loads(command.read_text(encoding='utf-8'))
            subprocess.run([shutil.which('npm') or 'npm', 'run', 'check'], cwd=plugin, check=True, capture_output=True)
            try:
                checked = subprocess.run(['node', '--test', '--test-timeout=60000'], cwd=plugin, capture_output=True, encoding='utf-8', timeout=180)
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

    def test_private_files_excluded_and_symlink_sources_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            source = work / 'source'
            private_data = str(uuid.uuid4())
            for name in release.FILES:
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

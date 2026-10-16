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
                self.assertEqual(set(zipped.namelist()), {f'wax/{name}' for name in release.FILES})
                zipped.extractall(work / 'extracted')
            plugin = work / 'extracted/wax'
            for command in (plugin / 'commands/wax').glob('*.toml'):
                tomllib.loads(command.read_text(encoding='utf-8'))
            subprocess.run(['npm', 'run', 'check'], cwd=plugin, check=True, capture_output=True)
            checked = subprocess.run(['node', '--test', '--test-timeout=60000'], cwd=plugin, capture_output=True, encoding='utf-8', timeout=180)
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

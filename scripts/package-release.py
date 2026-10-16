"""Build a reproducible ZIP from an explicit list of public release files."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from strip_comments import strip

ROOT = Path(__file__).resolve().parents[1]
COMMANDS = ('init', 'join', 'plan', 'design', 'implement', 'review', 'report', 'status', 'iterate', 'chat', 'daily', 'pm', 'work')
CHAT = ('paths', 'validate', 'store', 'lock', 'channels', 'presence', 'board', 'digest', 'watcher', 'listeners', 'watch', 'skills', 'daily', 'team', 'usage', 'tools', 'tool-news', 'requests', 'server', 'cli')
WEB_TYPES = {'.html', '.mjs', '.css', '.svg', '.png', '.json'}


def web_files(root):
    """Dashboard pages and the generated office assets (no source art)."""
    return tuple(sorted(path.relative_to(root).as_posix() for path in (root / 'web').rglob('*') if path.is_file() and path.suffix in WEB_TYPES))


FILES = (
    'package.json', 'LICENSE', 'README.md', 'INSTALL.md',
    'GEMINI.md', 'gemini-extension.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json', '.github/plugin/marketplace.json', '.claude-plugin/marketplace.json',
    'claude-mods/hooks.json', 'claude-mods/usage.mjs', 'hooks/hooks.json',
    'bin/wax-approval-hook.mjs', 'src/approvals.mjs', 'src/approval-hosts.mjs', 'src/approval-cli.mjs', 'src/codex-session.mjs', 'src/agent-tools.mjs', 'src/agent-session.mjs', 'docs/APPROVALS.md', 'scripts/verify-approvals-browser.mjs',
    'bin/wax.mjs', 'src/workflow.mjs', 'src/context.mjs', 'src/file-lock.mjs', 'src/backup.mjs', 'src/evidence.mjs', 'src/proof-schema.mjs', 'src/diagnostics.mjs', 'docs/USER_GUIDE.md', 'SECURITY.md', '.gitignore',
    'scripts/build-commands.mjs', 'scripts/package-release.py', 'scripts/strip_comments.py', 'scripts/install-codex.mjs', 'scripts/verify-windows.mjs', 'scripts/chat-demo.mjs', 'scripts/verify-requests-browser.mjs',
    *(f'src/chat/{name}.mjs' for name in CHAT),
    *web_files(ROOT),
    'test/workflow.test.mjs', 'test/context.test.mjs', 'test/approvals.test.mjs', 'test/approvals-ui.test.mjs', 'test/approval-retention.test.mjs', 'test/backup-evidence.test.mjs', 'test/codex.test.mjs', 'test/diagnostics.test.mjs', 'test/package_test.py', 'test/chat-helpers.mjs', 'test/chat-requests.test.mjs', 'test/agent-session.test.mjs',
    *(f'test/chat-{name}.test.mjs' for name in ('board', 'channels', 'cli', 'digest', 'presence', 'server', 'validate', 'office-model', 'ui-safety', 'team-daily', 'watch', 'skills', 'commands', 'usage', 'tools', 'dashboard-model', 'dashboard-proof', 'dialog-surface', 'workflow-demo', 'review-regressions', 'round4', 'round5', 'round6', 'tool-news', 'cross-session')),
    *(f'commands/{name}.md' for name in COMMANDS),
    *(f'commands/wax/{name}.toml' for name in COMMANDS),
    *(f'skills/{name}/{file}' for name in COMMANDS for file in ('SKILL.md', 'run.mjs')),
)


TEXT_TYPES = {'.md', '.mjs', '.js', '.json', '.toml', '.html', '.css', '.svg', '.py', '.txt', ''}


def release_bytes(path, comments=False):
    """File content as published: text files always use LF, even from a CRLF (Windows) checkout, and code without comments."""
    data = path.read_bytes()
    if path.suffix not in TEXT_TYPES:
        return data
    text = data.decode('utf-8').replace('\r\n', '\n')
    generated = path.name == 'run.mjs' and path.parent.parent.name == 'skills'
    return (text if comments or generated else strip(path.name, text)).encode('utf-8')


def build_release(root, destination):
    version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Release version must be major.minor.patch')
    for name in ('.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'gemini-extension.json', 'plugin.json'):
        if json.loads((root / name).read_text(encoding='utf-8'))['version'] != version:
            raise ValueError(f'Version mismatch: {name}')
    for name in ('.github/plugin/marketplace.json', '.claude-plugin/marketplace.json'):
        market = json.loads((root / name).read_text(encoding='utf-8'))
        if market['metadata']['version'] != version or any(plugin['version'] != version for plugin in market['plugins']):
            raise ValueError(f'Version mismatch: {name}')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(FILES):
            path = root / name
            if any((root / Path(*Path(name).parts[:i])).is_symlink() for i in range(1, len(Path(name).parts) + 1)):
                raise ValueError(f'Release files must not be symlinks: {name}')
            entry = zipfile.ZipInfo(f'wax/{name}', date_time=(2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (0o100755 if name == 'bin/wax.mjs' else 0o100644) << 16
            archive.writestr(entry, release_bytes(path))
    data = buffer.getvalue()
    filename = f'wax-{version}.zip'
    digest = hashlib.sha256(data).hexdigest()
    changelog = root / 'CHANGELOG.md'
    if changelog.exists() and f'## {version} —' not in changelog.read_text(encoding='utf-8'):
        raise ValueError(f'CHANGELOG.md must have a "## {version} —" entry')
    metadata = {'name': 'wax', 'version': version, 'filename': filename,
                'bytes': len(data), 'sha256': digest, 'license': 'AGPL-3.0-only', 'node': '>=22'}
    destination.mkdir(parents=True, exist_ok=True)
    (destination / filename).write_bytes(data)
    (destination / 'wax-latest.zip').write_bytes(data)
    (destination / 'latest.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    (destination / 'SHA256SUMS.txt').write_text(
        f'{digest}  {filename}\n{digest}  wax-latest.zip\n', encoding='utf-8')
    (destination / 'wax-manual.md').write_bytes(release_bytes(root / 'docs/USER_GUIDE.md'))
    (destination / 'CHANGELOG.md').unlink(missing_ok=True)
    return metadata


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    print(json.dumps(build_release(ROOT, args.out_dir), indent=2))

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
CHAT = ('paths', 'validate', 'store', 'lock', 'event-hub', 'channels', 'presence', 'board', 'digest', 'watcher', 'listeners', 'watch', 'skills', 'skill-map', 'work-notes', 'rules', 'daily', 'team', 'usage', 'tools', 'tool-news', 'cron', 'trigger-github', 'triggers', 'pm-judge', 'pm-loop', 'requests', 'design-mcp', 'design', 'server', 'cli')
WEB_TYPES = {'.html', '.mjs', '.css', '.svg', '.png', '.json'}


def test_files(root):
    """Every behavioral test, so a release can check itself with node --test.
    bump-version tests the source repository's release tooling against CHANGELOG.md, which a release does not ship."""
    return tuple(sorted(path.relative_to(root).as_posix() for path in (root / 'test').glob('*.test.mjs') if path.name != 'bump-version.test.mjs'))


def web_files(root):
    """Dashboard pages and the generated office assets (no source art)."""
    return tuple(sorted(path.relative_to(root).as_posix() for path in (root / 'web').rglob('*') if path.is_file() and path.suffix in WEB_TYPES))


FILES = (
    'package.json', 'LICENSE', 'README.md', 'INSTALL.md',
    'GEMINI.md', 'gemini-extension.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json', '.agents/plugins/marketplace.json', '.github/plugin/marketplace.json', '.github/workflows/public.yml', '.claude-plugin/marketplace.json',
    'claude-mods/hooks.json', 'claude-mods/usage.mjs', 'hooks/hooks.json',
    'bin/wax-approval-hook.mjs', 'src/approvals.mjs', 'src/approval-hosts.mjs', 'src/approval-cli.mjs', 'src/codex-session.mjs', 'src/agent-tools.mjs', 'src/agent-session.mjs', 'docs/APPROVALS.md', 'scripts/verify-approvals-browser.mjs',
    'bin/wax.mjs', 'src/sqlite.mjs', 'src/search.mjs', 'src/search-sources.mjs', 'src/search-cli.mjs', 'src/recall.mjs', 'src/wiki.mjs', 'src/wiki-cli.mjs', 'src/cli-locale.mjs', 'docs/SEARCH.md', 'scripts/bench-search.mjs', 'scripts/verify-search-browser.mjs', 'src/workflow.mjs', 'src/quality.mjs', 'src/acceptance.mjs', 'src/durations.mjs', 'src/context.mjs', 'src/pr-body.mjs', 'src/run-trace.mjs', 'src/file-lock.mjs', 'src/backup.mjs', 'src/evidence.mjs', 'src/freshness.mjs', 'src/capture.mjs', 'src/project-detect.mjs', 'src/proof-schema.mjs', 'src/diagnostics.mjs', 'docs/USER_GUIDE.md', 'docs/USER_GUIDE.en.md', 'docs/DESIGN_STUDIO.md', 'SECURITY.md', '.gitignore',
    'scripts/build-commands.mjs', 'scripts/skill-size.mjs', 'scripts/skill-budget.json', 'scripts/build-faces.mjs', 'scripts/import-side-prop.mjs', 'scripts/import-studio-art.mjs', 'scripts/package-release.py', 'scripts/bump-version.mjs', 'scripts/strip_comments.py', 'scripts/install-project.mjs', 'scripts/install-codex.mjs', 'scripts/verify-codex-marketplace.mjs', 'scripts/verify-windows.mjs', 'scripts/chat-demo.mjs', 'scripts/verify-requests-browser.mjs', 'scripts/verify-threads-browser.mjs', 'scripts/verify-design-browser.mjs', 'scripts/i18n-strings.mjs', 'scripts/verify-i18n-browser.mjs', 'scripts/verify-notify-browser.mjs', 'scripts/verify-trace-browser.mjs',
    'src/status.mjs', 'src/mcp.mjs', 'src/mcp-config.mjs', 'src/visual-compare.mjs', 'scripts/verify-compare-browser.mjs',
    'scripts/verify-triggers-browser.mjs', 'src/trigger-cli.mjs',
    'scripts/verify-pm-loop-browser.mjs', 'src/pm-loop-cli.mjs',
    *(f'src/chat/{name}.mjs' for name in CHAT),
    *web_files(ROOT),
    'test/package_test.py', 'test/chat-helpers.mjs', 'test/korean-output.mjs',
    *test_files(ROOT),
    *(f'commands/{name}.md' for name in COMMANDS),
    *(f'commands/wax/{name}.toml' for name in COMMANDS),
    *(f'skills/{name}/{file}' for name in COMMANDS for file in ('SKILL.md', 'run.mjs')),
)


_UNLISTED = sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / 'src').rglob('*.mjs') if path.relative_to(ROOT).as_posix() not in FILES)
if _UNLISTED:
    raise SystemExit(f'FILES에 없는 src 모듈: {", ".join(_UNLISTED)} — scripts/package-release.py에 추가하세요.')

SECRET = r'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

TEXT_TYPES = {'.md', '.mjs', '.js', '.json', '.toml', '.yml', '.html', '.css', '.svg', '.py', '.txt', ''}


def release_bytes(path, comments=False):
    """File content as published: text files always use LF, even from a CRLF (Windows) checkout, and code without comments."""
    data = path.read_bytes()
    if path.suffix not in TEXT_TYPES:
        return data
    text = data.decode('utf-8').replace('\r\n', '\n')
    generated = path.name == 'run.mjs' and path.parent.parent.name == 'skills'
    return (text if comments or generated else strip(path.name, text)).encode('utf-8')


def _version_key(value):
    return tuple(int(part) for part in value.split('.'))


def release_notes(root, version, since=None):
    """Notes for one release. With since (the last published version), versions after it that were never
    published on their own are added below this version's changes, newest first."""
    changelog = root / 'CHANGELOG.md'
    published = root / 'RELEASE_NOTES.md'
    for path in (changelog, published):
        if path.is_symlink():
            raise ValueError(f'Release files must not be symlinks: {path.name}')
    if changelog.exists():
        text = changelog.read_text(encoding='utf-8')
        section = re.search(rf'^## {re.escape(version)} —([^\n]*)(?:\n|\Z)(.*?)(?=^## |\Z)', text, re.MULTILINE | re.DOTALL)
        if not section:
            raise ValueError(f'CHANGELOG.md must have a "## {version} —" entry')
        heading, body = f'# wax {version} — {section[1].strip()}', section[2]
        if since:
            if not re.fullmatch(r'\d+\.\d+\.\d+', since) or _version_key(since) >= _version_key(version):
                raise ValueError('--notes-since must be an earlier major.minor.patch version')
            for match in re.finditer(r'^## (\d+\.\d+\.\d+) —([^\n]*)(?:\n|\Z)(.*?)(?=^## |\Z)', text, re.MULTILINE | re.DOTALL):
                if _version_key(since) < _version_key(match[1]) < _version_key(version):
                    body = f'{body.rstrip()}\n\n## {match[1]} — {match[2].strip()}\n\n{match[3].strip()}\n'
    else:
        if not published.is_file():
            raise ValueError('RELEASE_NOTES.md is missing; use a complete release archive or add notes for this version')
        heading, _, body = published.read_text(encoding='utf-8').partition('\n')
        if not re.fullmatch(rf'# wax {re.escape(version)}(?: — [^\n]+)?', heading):
            raise ValueError('RELEASE_NOTES.md must match the release version')
    cleaned = re.sub(r'<!--.*?-->', '', f'{heading}\n\n{body}', flags=re.DOTALL)
    if '<!--' in cleaned:
        raise ValueError('Release notes contain an unterminated HTML comment')
    heading, _, body = cleaned.partition('\n')
    body = body.strip()
    if not body:
        raise ValueError('Release notes must contain changes, not just a version heading')
    notes = f'{heading.rstrip()}\n\n{body}\n'
    forbidden = SECRET + r'|/(?:Users|home)/[^\s`]+|[A-Z]:\\Users\\'
    if re.search(forbidden, notes):
        raise ValueError('Release notes contain a possible secret or private machine path')
    return notes


def build_release(root, destination, notes_since=None):
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
    notes = release_notes(root, version, notes_since).encode('utf-8')
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted((*FILES, 'RELEASE_NOTES.md')):
            path = root / name
            if any((root / Path(*Path(name).parts[:i])).is_symlink() for i in range(1, len(Path(name).parts) + 1)):
                raise ValueError(f'Release files must not be symlinks: {name}')
            entry = zipfile.ZipInfo(f'wax/{name}', date_time=(2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (0o100755 if name == 'bin/wax.mjs' else 0o100644) << 16
            data = notes if name == 'RELEASE_NOTES.md' else release_bytes(path)
            if Path(name).suffix in TEXT_TYPES and re.search(SECRET, data.decode('utf-8', 'ignore')):
                raise ValueError(f'Release file contains a possible secret: {name}')
            archive.writestr(entry, data)
    data = buffer.getvalue()
    filename = f'wax-{version}.zip'
    digest = hashlib.sha256(data).hexdigest()
    metadata = {'name': 'wax', 'version': version, 'filename': filename,
                'bytes': len(data), 'sha256': digest, 'license': 'AGPL-3.0-only', 'node': '>=22'}
    destination.mkdir(parents=True, exist_ok=True)
    (destination / filename).write_bytes(data)
    (destination / 'wax-latest.zip').write_bytes(data)
    (destination / 'latest.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    (destination / 'SHA256SUMS.txt').write_text(
        f'{digest}  {filename}\n{digest}  wax-latest.zip\n', encoding='utf-8')
    (destination / 'wax-manual.md').write_bytes(release_bytes(root / 'docs/USER_GUIDE.md'))
    (destination / 'RELEASE_NOTES.md').write_bytes(notes)
    (destination / 'CHANGELOG.md').unlink(missing_ok=True)
    return metadata


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out-dir', type=Path, default=ROOT / 'dist')
    parser.add_argument('--notes-since', help='last published version; unpublished versions after it join the release notes')
    args = parser.parse_args()
    print(json.dumps(build_release(ROOT, args.out_dir, args.notes_since), indent=2))

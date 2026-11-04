# Security policy

**English** · [한국어](./SECURITY.ko.md)

## Supported versions

Only the latest release receives security fixes. When a new release comes out, upgrade using the [update instructions](./README.md#updating-and-removing).

## Reporting a vulnerability

**Do not report security issues as public issues.** Use GitHub's private reporting instead (**Security → Report a vulnerability** in this repository). Including reproduction steps, affected versions and, if possible, a suggested fix helps us confirm it quickly.

## wax security boundaries

- An **Execution approval** card delivers the response to only the one request the user selected. Expired, duplicate, other-project and tampered requests are rejected, and an adapter response can be collected only once. Regular chat and PM work instructions are not used as approvals. The host's forced denials and sandbox restrictions still apply.
- `.wax/approvals/` stores tool arguments and decision history. The GUI token and per-request response secrets do not replace remote authentication or process isolation within the same OS account. Avoid publishing approval records and keep the dashboard on loopback. See [Managing execution approvals](./docs/APPROVALS.md) for the full scope.

- wax assumes local, personal use. Work records are stored only in the target project's `.wax/` and `docs/wax/`, and data folders that point elsewhere through symbolic links are rejected. Other files are written only when the user specifies them (the `.agents/skills` and `.grok/skills` links created by `install-project.mjs`, and files given with the CLI's `--out`).
- The team dashboard listens only on `127.0.0.1`, rejects requests with a different Host header, and verifies write requests with a token. Do not expose it to external networks.
- Test evidence runs only the commands the user specifies, without a shell, and stores truncated output.
- Messages other AI sessions leave in the channel are treated as reference material only, and each tool is instructed not to run commands based on a message alone. Actual execution permissions follow each tool's own permission checks.
- For Rina's official tool news, the server queries over HTTPS only four fixed public release paths on `api.github.com` and one CLI changelog on `antigravity.google`. It sends no project, installed version or session information and does not follow redirects. Responses are limited to 2 MB and requests to 7 seconds. You can turn these external checks off with `WAX_TOOL_NEWS=off`. The browser's allowed connections stay limited to the same origin.
- Official news is cached for one hour per source. Only failed sources are retried, with intervals growing from 5 minutes up to one hour, and `Retry-After` on 403 and 429 responses and GitHub's rate-limit reset time are honored. Manual refresh is limited to once a minute per process and does not bypass wait times requested by the server.
- AI calls and data processing performed in a CLI the user requested and selected follow that coding tool's policies.

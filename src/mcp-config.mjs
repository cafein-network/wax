
export const MCP_HOSTS = ['claude', 'gemini', 'codex', 'copilot'];

const quoted = (args) => `[${args.map((arg) => JSON.stringify(arg)).join(', ')}]`;
const shell = (value) => (/^[\w@%+=:,./\\-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

export function mcpServerConfig(host, { wax, project }) {
  const args = [wax, 'mcp', '--project', project];
  if (host === 'claude') return `claude mcp add --transport stdio --env WAX_MCP=on wax -- node ${args.map(shell).join(' ')}`;
  if (host === 'gemini') return `{\n  "mcpServers": {\n    "wax": { "command": "node", "args": ${quoted(args)}, "env": { "WAX_MCP": "on" } }\n  }\n}`;
  if (host === 'codex') return `[mcp_servers.wax]\ncommand = "node"\nargs = ${quoted(args)}\nenv = { WAX_MCP = "on" }`;
  if (host === 'copilot') return `{\n  "mcpServers": {\n    "wax": { "type": "local", "command": "node", "args": ${quoted(args)}, "env": { "WAX_MCP": "on" }, "tools": ["*"] }\n  }\n}`;
  throw new Error(host);
}

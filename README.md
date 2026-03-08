# OpenClaw DimOS Bridge

An [OpenClaw](https://openclaw.dev) plugin that bridges [DimOS](https://github.com/dimensionalOS/dimos) MCP tools into the OpenClaw agent system. It discovers tools from a running DimOS MCP server over TCP and registers them as native OpenClaw agent tools.

## Architecture

```
OpenClaw Agent  ──▶  roboclaw plugin (bridge)  ──TCP/JSON-RPC──▶  DimOS MCP Server  ──▶  Robot
```

1. On plugin registration, connects to the DimOS MCP server and discovers available tools
2. Converts each MCP tool's JSON Schema into TypeBox schemas for OpenClaw's type system
3. When the agent invokes a tool, forwards the call over TCP and returns the result

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)
- [uv](https://github.com/astral-sh/uv) (for the Python DimOS server)
- Python >= 3.11

## Quick Start

**Terminal 1** — Start the DimOS MCP server:

```bash
uv sync
uv run dimos --viewer-backend rerun run unitree-go2-agentic-mcp
```

**Terminal 2** — Start the OpenClaw gateway and run an agent:

```bash
pnpm install
pnpm openclaw config set plugins.entries.dimos.enabled true
pnpm openclaw gateway stop && pnpm openclaw gateway run --port 18789 --verbose gateway.mode=local
```

```bash
pnpm openclaw agent --session-id dimos-test --message "move forward 10 meters"
```

## Configuration

Configure the plugin in your OpenClaw config:

| Option    | Type     | Default       | Description                  |
|-----------|----------|---------------|------------------------------|
| `mcpHost` | `string` | `127.0.0.1`   | DimOS MCP server hostname    |
| `mcpPort` | `number` | `9990`        | DimOS MCP server port        |

Example:

```bash
pnpm openclaw config set plugins.entries.dimos.config.mcpHost "192.168.1.100"
pnpm openclaw config set plugins.entries.dimos.config.mcpPort 9991
```

## Troubleshooting

- **Plugin loads 0 tools**: Ensure the DimOS MCP server is running and reachable at the configured host:port before starting the OpenClaw gateway.
- **Connection refused**: Check that the port is correct and no firewall is blocking TCP connections to the DimOS server.
- **Timeout errors**: The default tool call timeout is 30 seconds. Long-running robot operations may need the DimOS server to respond within this window.

# OpenClaw DimOS Plugin

An [OpenClaw](https://openclaw.ai/) plugin that bridges [DimOS](https://github.com/dimensionalOS/dimos) (Dimensional OS) robotics tools into the OpenClaw agent system. This lets you control a Unitree Go2 robot through natural language via an OpenClaw chat interface.

The plugin connects to the DimOS MCP server over HTTP, discovers all available robot skills (movement, navigation, perception, spatial memory), and registers them as OpenClaw agent tools.

## Setup

### 1. Configure environment

Copy the default env file and fill in your keys:

```bash
cp default.env .env
```

Edit `.env` and set:
- `ANTHROPIC_API_KEY` — used by the OpenClaw agent
- `OPENAI_API_KEY` — used by the DimOS agent
- `OPENCLAW_GATEWAY_TOKEN` — shared token for gateway auth (e.g. `test123`)
- `ROBOT_IP` — your Unitree Go2's IP address (if testing on hardware)

### 3. Install and enable the plugin

```bash
pnpm openclaw plugins install -l .
pnpm openclaw config set plugins.entries.dimos.enabled true
pnpm openclaw config set gateway.mode local
```

## Running

You need three terminals:

### Terminal 1 — DimOS MCP server

From your DimOS directory:

```bash
uv sync
uv run dimos run unitree-go2-agentic-mcp
```

This starts the MCP server on `http://127.0.0.1:9990/mcp` exposing robot skills.

### Terminal 2 — OpenClaw gateway

From this directory:

```bash
pnpm openclaw gateway run --port 18789 --verbose
```

You should see `dimos: discovered 13 tool(s) from 127.0.0.1:9990` confirming the plugin loaded.

### Terminal 3 — Send commands

From this directory:

```bash
pnpm openclaw agent --session-id dimos-test --message "move forward 1 meter"
```

Or use the interactive TUI:

```bash
pnpm openclaw tui
```

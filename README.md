# OpenClaw Dimensional

In one terminal, run the following commands:

```bash
uv sync
```

```bash
uv run dimos --viewer-backend rerun run unitree-go2-agentic-mcp
```

In another terminal, run the following commands:

```bash
pnpm install
```

```bash
pnpm openclaw config set plugins.entries.dimos.enabled true
```

```bash
pnpm openclaw gateway stop && pnpm openclaw gateway run --port 18789 --verbose gateway.mode=local
```

```bash
pnpm openclaw agent --session-id dimos-test --message "move forward 10 meters"
```

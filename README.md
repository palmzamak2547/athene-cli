# 🦉 Athene CLI

A free, frontier-class, MCP-native terminal coding agent — part of the open **Athene** suite.

Athene runs an agentic loop (read → reason → edit → verify) over your codebase using
**free** frontier models. It doesn't train a model; it orchestrates the best open ones
(NVIDIA NIM, Groq, Cerebras, OpenRouter) behind one OpenAI-compatible interface, with
effort tiers so you only pay latency when the task is hard.

> Thesis: the better closed-source gets, the better open-source gets right behind it.
> Frontier *feel* comes from orchestration — routing, tools, verification — not model size.

## Quick start

```bash
npm install
export NVIDIA_API_KEY=nvapi-...        # free at build.nvidia.com
npm run athene -- "explain what this repo does"
npm run athene -- -y "add a --version flag and update the README"
```

## Usage

```
athene "<task>" [options]

  -e, --effort <fast|balanced|deep>   model tier (default: balanced)
      --fast / --deep                 shorthands
  -y, --yolo                          allow file writes + shell commands (default: read-only)
      --max-steps <n>                 max agent steps (default: 24)
  -h, --help
```

- **fast** — Groq `gpt-oss-20b` / Cerebras (sub-second) for quick edits + Q&A
- **balanced** (default) — NIM `qwen3-coder-480b` — the best free coder
- **deep** — NIM `deepseek-r1` — reasoning for hard problems

Set any of `NVIDIA_API_KEY` (always-on floor), `GROQ_API_KEY`, `CEREBRAS_API_KEY`,
`OPENROUTER_API_KEY`. Athene uses the first available provider per tier.

## Safety

Read-only by default (read_file, list_dir). File writes + shell commands require
`--yolo`. An interactive per-action approval prompt is on the roadmap.

## Status

v0.0.1 — working agent loop with `read_file`, `list_dir`, `write_file`, `edit_file`,
`bash`. Next: MCP client (connect to any MCP server), interactive approval, an Ink TUI,
a `semantic-router` effort classifier, and a groundedness check (Iron Rule 0).

## Roadmap (the Athene suite)

- **Athene CLI** — this. The flagship dev agent.
- **Athene Design** — prompt → editable UI/app.
- **Athene Desktop** — a native (Tauri) AI app.

MIT licensed. Built on the Vercel AI SDK + Model Context Protocol.

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
export NVIDIA_API_KEY=nvapi-...                 # free at build.nvidia.com

# Run instantly, no install:
npx athene-cli "explain what this repo does"

# …or install the `athene` command globally:
npm install -g athene-cli
athene "add a --version flag and update the README"   # shows a diff, asks before each edit
athene -y "fix the failing test"                       # auto-approve, no prompts
```

### From source

```bash
git clone https://github.com/palmzamak2547/athene-cli && cd athene-cli && npm install
npm run athene -- "explain what this repo does"
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

- **fast** — Groq `gpt-oss-20b` / NIM `llama-3.3-70b` (sub-second) for quick edits + Q&A
- **balanced** (default) — NIM `qwen3.5-122b` — a strong free coder
- **deep** — NIM `deepseek-v4` — reasoning for hard problems

Model IDs are verified against the live NIM catalog and the chain **fails over**
automatically (a model that goes EOL → 410 just falls to the next free one). Set any
of `NVIDIA_API_KEY` (always-on floor), `GROQ_API_KEY`, `CEREBRAS_API_KEY`,
`OPENROUTER_API_KEY`.

## MCP — composable

Point Athene at any [Model Context Protocol](https://modelcontextprotocol.io) server
and its tools join the built-ins. Create `athene.json` (project) or
`~/.athene/config.json` (global). `${VAR}` is substituted from the environment, so
you never hardcode a token:

```json
{
  "mcpServers": {
    "context7": { "url": "https://mcp.context7.com/mcp" },
    "gitmcp":   { "url": "https://gitmcp.io/docs" },
    "hf":       { "url": "https://huggingface.co/mcp", "headers": { "Authorization": "Bearer ${HF_TOKEN}" } },
    "arnfa":    { "command": "npx", "args": ["arnfa-mcp"] }
  }
}
```

A broken/slow server is skipped, never fatal. See `athene.example.json` for the
recommended set (Context7 = version-correct library docs · GitMCP = any-repo source ·
fetch · sequential-thinking · HuggingFace). Context7 + GitMCP are the biggest
out-of-the-box precision wins for a coding agent, and need no key.

## Skills & project memory

Athene reads the **same skill bank Claude Code + grok share** — `~/.claude/skills`
(and its own `~/.athene/skills`). Each skill's name + one-line purpose is surfaced
to the model; the full instructions load on demand via `use_skill`. Drop an
`AGENTS.md` (or `CLAUDE.md`) in a project and Athene loads it as up-front context.

## Safety

- **Approval** — by default Athene shows a diff / the command and asks before each
  change (in a terminal); `--yolo` auto-approves; piped/non-interactive is read-only.
- **Sandboxed paths** — file tools are confined to the working directory (no `../`,
  no absolute paths).
- **Secret-aware** — won't read `.env`/`*.pem`/keys into the model; strips secrets
  from spawned MCP servers' environment.
- **Destructive-command block** — refuses `rm -rf /`, fork bombs, `dd→/dev`, etc.
  even with `--yolo`.
- **Trust boundary** — file/tool/MCP contents are treated as data, never commands.

## Status

**v0.4** — working multi-step agent on free frontier models, with: runtime model
failover, diff-before-apply approval (3 modes), MCP client, a tolerant edit matcher
(exact → line-trimmed → whitespace, EOL/BOM-aware), a runaway-loop guard, and the
safety guards above. Reviewed by a 3-model loop (Claude + grok + codex).

**Next** (frontier patterns from Codex / Claude Code / aider / opencode): dedicated
`grep`/`glob` tools (vs shell), `multi_edit`, post-edit verify loop, `AGENTS.md`
project memory, an interactive REPL + slash-commands, and a `semantic-router` effort
classifier.

## The Athene suite

- **Athene CLI** — this. The flagship dev agent.
- **Athene Design** — prompt → editable UI/app.
- **Athene Desktop** — a native (Tauri) AI app.

MIT licensed. Built on the Vercel AI SDK + Model Context Protocol.

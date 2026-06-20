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
athene                                                 # interactive session (keeps context)
athene "add a --version flag and update the README"    # one task; shows a diff, asks before edits
athene -y "fix the failing test"                       # auto-approve, no prompts
```

In an interactive session, history is kept across turns (course-correct freely),
and slash commands tweak it live: `/effort deep`, `/clear`, `/help`, `/exit`.

### From source

```bash
git clone https://github.com/palmzamak2547/athene-cli && cd athene-cli && npm install
npm run athene -- "explain what this repo does"
```

## Usage

```
athene                  interactive session (in a terminal)
athene "<task>"         run a single task

  -e, --effort <fast|balanced|deep>   model tier (default: balanced)
      --fast / --deep                 shorthands
  -y, --yolo                          allow file writes + shell commands (default: read-only)
      --plan                          read-only: propose a plan for approval, don't edit
      --verify / --no-verify          run the project's check after a file change + self-correct
      --max-steps <n>                 max agent steps (default: 24)
  -v, --version                       print version
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

A working multi-step agent on free frontier models. Shipped:

- **Failover** across NVIDIA NIM / Groq / Cerebras / OpenRouter / HuggingFace,
  three effort tiers (fast / balanced / deep), runtime model rotation, and
  forced single-tool-calls so smaller models don't 400 on parallel calls.
- **Search + edit tools** — `grep` + `glob` (ripgrep fast-path, dependency-free
  Node fallback), `read_file`, `list_dir`, `write_file`, `edit_file` (tolerant
  exact → line-trimmed → whitespace matcher, EOL/BOM-aware), `multi_edit`
  (atomic), `bash`.
- **Interactive REPL** — `athene` (no task) keeps conversation history across
  turns; slash commands `/effort`, `/verify`, `/plan`, `/diff`, `/init`,
  `/clear`, plus your own `.athene/commands/*.md` templated commands
  (`$ARGUMENTS`, `$1`…).
  Ctrl-C interrupts a running task (and quits at the idle prompt); the status
  line shows the git branch. Long sessions **auto-compact** — older turns are
  summarized (at a clean boundary, never orphaning a tool result) so the context
  window never overflows.
- **Plan mode** (`--plan` / `/plan`) — explore read-only and propose a plan for
  approval; every edit/command is declined until you turn it off.
- **Sub-agents** (`task` tool) — the agent delegates a big self-contained sub-job
  to a fresh sub-agent with its own context; only the sub-agent's report comes
  back, so the main context stays lean. One level deep (no recursion); the
  sub-agent's edits are still approval-gated.
- **Verify loop** — after a file change, runs the project's check (typecheck /
  build / cargo check / go build) and feeds failures back to self-correct;
  on by default under `--yolo` (`--verify` / `--no-verify` to override). It
  won't make a check pass by weakening or deleting the test.
- **Skills + memory** — inherits the shared `~/.claude/skills` bank; loads
  `AGENTS.md` / `CLAUDE.md` as project context (treated as data, not commands).
- **MCP client** — any stdio/HTTP server's tools join the built-ins.
- **Safety** — diff-before-apply approval (3 modes), cwd path confinement,
  secret-file refusal, destructive-command block, runaway-loop guard, and a
  trust boundary hardened against the documented injection vectors (config /
  dotfile / memory-file payloads), plus Iron Rule 0 extended to package
  existence + system-state claims.
- **Tested** — `npm test` (37 unit tests) + CI on every push; reviewed by a
  3-model loop (Claude + grok + codex) and informed by a study of frontier
  agents' documented failure modes.

**Next** (frontier patterns from Codex / Claude Code / Grok Build): per-turn
rewind (restore conversation + working tree), parallel sub-agents, and a
config file for defaults. Then the rest of the suite — Athene Design (prompt →
editable UI, Phase 0 live) and Athene Desktop (local + free models).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node's test runner — edit matcher, glob, skills
                    # frontmatter, safety guards, loop guard
npm run build       # tsup → dist/cli.js
```

## The Athene suite

- **Athene CLI** — this. The flagship dev agent.
- **Athene Design** — prompt → editable UI/app.
- **Athene Desktop** — a native (Tauri) AI app.

MIT licensed. Built on the Vercel AI SDK + Model Context Protocol.

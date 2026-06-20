// src/mcp.ts
//
// MCP client — this is what makes Athene "composable": point it at any Model
// Context Protocol server (our arnfa-mcp, a Supabase/Playwright/GitHub server,
// anything) and that server's tools appear to the agent alongside the built-ins.
//
// Config (merged, project overrides global):
//   ./athene.json                     (project)
//   ~/.athene/config.json             (global)
//   { "mcpServers": {
//       "arnfa":  { "command": "npx", "args": ["arnfa-mcp"] },
//       "remote": { "url": "https://example.com/mcp" } } }
//
// We use the official @modelcontextprotocol/sdk for the client + transports and
// adapt each MCP tool into an AI SDK dynamicTool (its JSON Schema → jsonSchema()).
// A broken/slow server is logged and SKIPPED, never fatal. Tool names are
// namespaced `<server>__<tool>` to avoid collisions. MCP calls route through the
// same approver as local mutations (you configured the server = some trust, but
// an external action still gets a yes/no on a TTY).
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { dynamicTool, jsonSchema } from "ai";
import type { Approver } from "./approval.js";

export type McpServerConfig =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };

type Config = { mcpServers?: Record<string, McpServerConfig> };

async function readJson(file: string): Promise<Config | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Config;
  } catch {
    return null;
  }
}

export async function loadMcpConfig(): Promise<Record<string, McpServerConfig>> {
  const global = await readJson(path.join(os.homedir(), ".athene", "config.json"));
  const local = await readJson(path.join(process.cwd(), "athene.json"));
  const merged = { ...(global?.mcpServers ?? {}), ...(local?.mcpServers ?? {}) };
  return substituteEnv(merged);
}

// Replace ${VAR} in any string value with process.env.VAR, so a config can
// reference a token (e.g. "Bearer ${HF_TOKEN}") without hardcoding the secret.
function substituteEnv<T>(v: T): T {
  if (typeof v === "string") {
    return v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "") as unknown as T;
  }
  if (Array.isArray(v)) return v.map((x) => substituteEnv(x)) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = substituteEnv(val);
    return out as T;
  }
  return v;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function resultToString(res: any): string {
  const content = res?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    const body = text || JSON.stringify(content);
    const out = body.length > 30_000 ? body.slice(0, 30_000) + "\n…(truncated)" : body;
    return res?.isError ? `ERROR: ${out}` : out;
  }
  return JSON.stringify(res ?? {}).slice(0, 30_000);
}

function argsPreview(args: unknown): string {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "";
  }
}

// Don't hand a spawned MCP server the user's whole environment (API keys, tokens).
// Forward everything EXCEPT obvious secrets; a server's own secret goes in its
// `env` config explicitly, which is re-applied last. (grok review)
function safeChildEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...(extra ?? {}) };
}

export type McpHandle = {
  tools: Record<string, ReturnType<typeof dynamicTool>>;
  summary: string[]; // e.g. ["arnfa (6 tools)"]
  close: () => Promise<void>;
};

export async function connectMcp(
  servers: Record<string, McpServerConfig>,
  approve: Approver,
  onActivity: (line: string) => void,
  onLog: (line: string) => void,
): Promise<McpHandle> {
  const tools: Record<string, ReturnType<typeof dynamicTool>> = {};
  const summary: string[] = [];
  const clients: Client[] = [];

  for (const [name, cfg] of Object.entries(servers)) {
    let client: Client | undefined;
    let registered = false;
    try {
      const transport =
        "url" in cfg
          ? new StreamableHTTPClientTransport(
              new URL(cfg.url),
              cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
            )
          : new StdioClientTransport({
              command: cfg.command,
              args: cfg.args ?? [],
              env: safeChildEnv(cfg.env),
            });
      client = new Client({ name: "athene", version: "0.0.1" }, { capabilities: {} });
      await withTimeout(client.connect(transport), 20_000, `connect ${name}`);
      const listed = await withTimeout(client.listTools(), 15_000, `listTools ${name}`);
      const mcpTools = listed.tools ?? [];
      const c = client; // definite, connected client for the tool closures

      for (const t of mcpTools) {
        const ns = `${name}__${t.name}`;
        tools[ns] = dynamicTool({
          description: (t.description ?? `${t.name} (via ${name})`).slice(0, 1024),
          inputSchema: jsonSchema((t.inputSchema as any) ?? { type: "object", properties: {} }),
          execute: async (args: unknown) => {
            const ok = await approve({ title: `call ${ns}`, preview: pcDim(argsPreview(args)) });
            if (!ok) return `DECLINED: user did not approve calling ${ns}.`;
            try {
              const res = await withTimeout(
                c.callTool({ name: t.name, arguments: (args ?? {}) as Record<string, unknown> }),
                60_000,
                `call ${ns}`,
              );
              onActivity(`called ${ns}`);
              return resultToString(res);
            } catch (e: any) {
              return `ERROR calling ${ns}: ${e?.message ?? e}`;
            }
          },
        });
      }

      clients.push(client);
      registered = true;
      summary.push(`${name} (${mcpTools.length} tool${mcpTools.length === 1 ? "" : "s"})`);
    } catch (e: any) {
      onLog(`MCP "${name}" unavailable: ${e?.message ?? e}`);
    } finally {
      // grok review: if connect succeeded but a later step failed, the client (and
      // its child process) would leak. Close any client we never registered.
      if (client && !registered) {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  return {
    tools,
    summary,
    close: async () => {
      for (const c of clients) {
        try {
          await c.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// Kept tiny + dependency-light: a dim wrapper so the args preview reads as
// secondary text without importing picocolors here.
function pcDim(s: string): string {
  return s ? `\x1b[2m   ${s}\x1b[22m` : "";
}

// src/todo.ts
//
// `todo_write` — a task checklist the agent maintains across a multi-step job
// (Claude Code's signature for long work). The model lays out the plan, then
// updates statuses as it goes; we render it so the USER stays oriented and the
// model stays on track. Session-scoped state (held in this closure). Read-mostly:
// it never touches the workspace, so it doesn't count as a side effect.
import { tool } from "ai";
import { z } from "zod";
import pc from "picocolors";

type Status = "pending" | "in_progress" | "completed";
type Todo = { content: string; status: Status };

function render(todos: Todo[]): string {
  return todos
    .map((t) => {
      const mark =
        t.status === "completed"
          ? pc.green("✔")
          : t.status === "in_progress"
            ? pc.yellow("◐")
            : pc.dim("○");
      const text = t.status === "completed" ? pc.dim(t.content) : t.content;
      return `   ${mark} ${text}`;
    })
    .join("\n");
}

export function makeTodoTool() {
  let todos: Todo[] = [];
  return {
    todo_write: tool({
      description:
        "Maintain a checklist for a multi-step task. Call it first to lay out the plan (all items 'pending'), then call it again to flip items to 'in_progress' and 'completed' as you work — pass the FULL updated list each time. Keeps the user oriented and keeps you on track. Use it for non-trivial multi-step work; skip it for a one-step task.",
      inputSchema: z.object({
        todos: z
          .array(
            z.object({
              content: z.string().min(1),
              status: z.enum(["pending", "in_progress", "completed"]),
            }),
          )
          .max(40),
      }),
      execute: async ({ todos: next }) => {
        todos = next as Todo[];
        const done = todos.filter((t) => t.status === "completed").length;
        process.stderr.write(`\n ${pc.cyan("☑")} ${pc.dim(`plan (${done}/${todos.length})`)}\n${render(todos)}\n\n`);
        return `Updated the checklist (${done}/${todos.length} done).`;
      },
    }),
  };
}

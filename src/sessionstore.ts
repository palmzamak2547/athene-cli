// src/sessionstore.ts
//
// Persistent sessions (opencode's daily-delight): a REPL conversation is saved
// to ~/.athene/sessions/<id>.json after each turn, keyed by the working
// directory, so `athene --continue` picks up the most recent session for THIS
// project right where you left off. Best-effort — a save/load failure never
// breaks the session.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = path.join(os.homedir(), ".athene", "sessions");

export async function saveSession(id: string, messages: any[]): Promise<void> {
  try {
    await fs.mkdir(DIR, { recursive: true });
    const tmp = path.join(DIR, `${id}.json.tmp`);
    const dest = path.join(DIR, `${id}.json`);
    await fs.writeFile(tmp, JSON.stringify({ cwd: process.cwd(), updated: Date.now(), messages }), "utf8");
    await fs.rename(tmp, dest); // atomic-ish: never leave a half-written file
  } catch {
    /* best effort */
  }
}

// The most recent saved session for the current working directory, or null.
export async function loadLatestSession(): Promise<any[] | null> {
  try {
    const files = await fs.readdir(DIR);
    const cwd = process.cwd();
    let best: any[] | null = null;
    let bestTime = 0;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const data = JSON.parse(await fs.readFile(path.join(DIR, f), "utf8"));
        if (
          data.cwd === cwd &&
          typeof data.updated === "number" &&
          data.updated > bestTime &&
          Array.isArray(data.messages) &&
          data.messages.length > 0
        ) {
          best = data.messages;
          bestTime = data.updated;
        }
      } catch {
        /* skip unreadable */
      }
    }
    return best;
  } catch {
    return null;
  }
}

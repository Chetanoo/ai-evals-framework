import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { stableStringify } from './text.js';

export const hashOf = (value: unknown) => createHash('sha256').update(stableStringify(value)).digest('hex');

// Appends one JSON object per line. Writes are queued, so concurrent callers never interleave.
export class JsonlWriter {
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly file: string) {}

  append(row: unknown): Promise<void> {
    const line = `${JSON.stringify(row)}\n`;
    this.queue = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await appendFile(this.file, line, 'utf8');
    });
    return this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const rows: T[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // A run killed mid-write can leave a partial last line; anything else is corruption.
      if (i < text.split('\n').length - 2) throw new Error(`${file}: invalid JSON on line ${i + 1}`);
    }
  }
  return rows;
}

// Persistent key → value cache in one append-only JSONL file. The last write for a key wins.
export class JsonlCache {
  private constructor(
    private readonly map: Map<string, unknown>,
    private readonly writer: JsonlWriter,
  ) {}

  static async open(file: string): Promise<JsonlCache> {
    const rows = await readJsonl<{ key: string; value: unknown }>(file);
    return new JsonlCache(new Map(rows.map((r) => [r.key, r.value])), new JsonlWriter(file));
  }

  get(key: string): unknown {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
    await this.writer.append({ key, value });
  }
}

// Per-key minimum spacing between calls (e.g. 20 requests/minute per model on new OpenRouter accounts).
export function createThrottle(perMinute: number) {
  const next = new Map<string, number>();
  const interval = perMinute > 0 ? 60_000 / perMinute : 0;
  return async (key: string) => {
    if (interval === 0) return;
    const now = Date.now();
    const slot = Math.max(now, next.get(key) ?? 0);
    next.set(key, slot + interval);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  };
}

// Runs async tasks with at most `limit` in flight. Results keep the order of the tasks.
// (Same as doc-agent-rag's src/lib/pool.ts.)
export async function runPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i];
      if (!task) break;
      results[i] = await task();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

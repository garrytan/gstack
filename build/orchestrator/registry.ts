import * as fs from "node:fs";
import * as path from "node:path";

export function safeRegistryKey(input: string): string {
  return (
    input
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "record"
  );
}

export function atomicWriteJson(
  filePath: string,
  value: unknown,
  opts: { mode?: number } = {},
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", {
    mode: opts.mode ?? 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

export function readJsonRegistry<T>(
  registryDir: string,
  isRecord: (value: unknown) => value is T,
  opts: {
    debugName?: string;
    onCorrupt?: (filePath: string, err: Error) => void;
  } = {},
): T[] {
  if (!fs.existsSync(registryDir)) return [];
  const records: T[] = [];
  for (const entry of fs.readdirSync(registryDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(registryDir, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (isRecord(parsed)) records.push(parsed);
    } catch (err) {
      opts.onCorrupt?.(filePath, err as Error);
      if (process.env.GSTACK_DEBUG) {
        console.warn(
          `[${opts.debugName ?? "registry"}] ignoring unreadable record ${filePath}: ${(err as Error).message}`,
        );
      }
    }
  }
  return records;
}

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export class JsonStoreError extends Error {
  constructor(filePath: string, operation: "read" | "write", detail?: string) {
    super(`Could not ${operation} ${basename(filePath)}${detail ? ` (${detail})` : ""}. The saved file was not replaced. Check the local data file and folder permissions.`);
    this.name = "JsonStoreError";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Replace JSON only after its complete replacement has been written and flushed. */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError("The JSON store value must be serializable.");
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, filePath);
    created = false;
  } finally {
    if (created) await unlink(temporaryPath).catch(() => undefined);
  }
}

/** A single-process store: reads and whole mutations share one transaction queue. */
export class JsonStore<T> {
  private value?: T;
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly parse: (value: unknown) => T,
    private readonly empty: () => T,
    private readonly write: (filePath: string, value: unknown) => Promise<void> = atomicWriteJson,
  ) {}

  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const request = this.queue.then(operation);
    this.queue = request.then(() => undefined, () => undefined);
    return request;
  }

  private async load(): Promise<T> {
    if (this.loaded) return this.value as T;
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw new JsonStoreError(this.filePath, "read", errorCode(error));
      this.value = this.empty();
      this.loaded = true;
      return this.value;
    }
    try {
      this.value = this.parse(JSON.parse(text) as unknown);
    } catch {
      // JSON parser errors can include private data; report only the filename.
      throw new JsonStoreError(this.filePath, "read", "invalid JSON or schema");
    }
    this.loaded = true;
    return this.value;
  }

  read(): Promise<T> {
    return this.enqueue(async () => structuredClone(await this.load()));
  }

  update<R>(mutate: (draft: T) => R): Promise<R> {
    return this.enqueue(async () => {
      const draft = structuredClone(await this.load());
      const result = mutate(draft);
      let validated: T;
      try {
        validated = this.parse(draft);
      } catch {
        throw new JsonStoreError(this.filePath, "write", "invalid schema");
      }
      try {
        await this.write(this.filePath, validated);
      } catch (error) {
        throw new JsonStoreError(this.filePath, "write", errorCode(error));
      }
      // A failed persistence attempt must not alter the committed in-memory view.
      this.value = validated;
      return structuredClone(result);
    });
  }
}

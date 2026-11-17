import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";

/**
 * A provider's small persistent state — poll cursors — as one JSON file under the app workspace
 * directory, so a restart resumes where the last run stopped instead of skipping or replaying the
 * traffic that arrived in between. Written atomically (temp file + rename).
 */
export default class ProviderStateFile<Schema extends z.ZodType> {
  constructor(
    readonly filePath: string,
    private readonly schema: Schema,
  ) {}

  /** The saved state, or undefined when there is none or it does not parse. */
  load(): z.output<Schema> | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = this.schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  save(state: z.input<Schema>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpFile = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(state)}\n`);
    fs.renameSync(tmpFile, this.filePath);
  }
}

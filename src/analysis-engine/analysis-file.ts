import { randomUUID } from "node:crypto";
import { link, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Write a complete file in the same directory, without replacing an existing file unless requested. */
export async function writeAnalysisFile(path: string, content: string, overwrite: boolean): Promise<void> {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    let temporaryExists = true;
    try {
        try {
            await handle.writeFile(content, "utf8");
        } finally {
            await handle.close();
        }
        if (overwrite) {
            await rename(temporary, path);
            temporaryExists = false;
        } else {
            await link(temporary, path);
        }
    } finally {
        if (temporaryExists) {
            await unlink(temporary);
        }
    }
}

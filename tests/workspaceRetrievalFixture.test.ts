import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workspace-unified-retrieval");
const expectedFiles = ["api/src/contracts/orders.ts", "api/src/routes/orders.go", "catalog/docs/zh-CN/inventory.md", "catalog/schema/item.schema.json", "catalog/src/CatalogItemDTO.ts", "worker/src/handlers/orderCreated.ts"];

async function filesAt(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? filesAt(path.join(directory, entry.name), path.join(prefix, entry.name)) : [path.join(prefix, entry.name).replaceAll("\\", "/")]))).flat().sort();
}

describe("workspace unified retrieval fixture", () => {
  it("has a deterministic repository file manifest and content hashes", async () => {
    const files = await filesAt(root);
    expect(files).toEqual(expectedFiles);
    const hashes = await Promise.all(files.map(async (file) => {
      const content = await readFile(path.join(root, file), "utf8");
      return createHash("sha256").update(content.replace(/\r\n?/gu, "\n")).digest("hex");
    }));
    expect(hashes).toEqual([
      "19bd2b947779f1ac7bbd587fba3db88ff17c7c8f0dc0e15d324c48bc49326e06",
      "e7faf5440bc55772cee7ed908dd0602a4a8501425fc0caa0c670feeb9dd63907",
      "5d204635fcf398d7df3ad44dfc795433580b1cec45f6fa11a9d95c363de2a1f1",
      "7ec881f8c54e740b37b7386867496f6db848a1c07a9e20257487a015fc308fef",
      "fa474ca6e81099cf63e6f37027b9aa41c99984c2cc7c42717b11adbc1a0db625",
      "18d9d42846ccf4cc3623b54338174bc38d561bfbff925ab8b7e0fb0f8777222d"
    ]);
  });
});

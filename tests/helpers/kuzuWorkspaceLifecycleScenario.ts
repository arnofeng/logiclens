import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { KuzuGraphDB } from "../../src/adapters/graph-db/kuzu/KuzuGraphDB.js";
import { KuzuWorkspaceLexicalStore, KUZU_WORKSPACE_FTS_INDEX } from "../../src/adapters/graph-db/kuzu/KuzuWorkspaceLexicalStore.js";
import { runWorkspaceLifecycleConformance, type WorkspaceLifecycleFixture } from "../retrieval/workspaceLifecycleConformanceHarness.js";

const directory = process.argv[2];
if (!directory) throw new Error("Expected a temporary Kuzu lifecycle directory.");
const filename = path.join(directory, "graph.kuzu");
let db = await KuzuGraphDB.open(filename);
let store = new KuzuWorkspaceLexicalStore(db);
const suffix = randomUUID().replace(/-/g, "");
const fixture: WorkspaceLifecycleFixture = {
  get db() { return db; },
  get store() { return store; },
  workspaceId: `workspace:kuzu-conformance:${suffix}`,
  suffix,
  async reopen() {
    await db.close();
    db = await KuzuGraphDB.open(filename);
    store = new KuzuWorkspaceLexicalStore(db);
    await store.ensureSchema();
  },
  async assertSingleIndex() {
    const indexes = await db.query<{ index_name: string }>(
      "CALL SHOW_INDEXES() WHERE table_name = 'LexicalDocument' RETURN index_name;"
    );
    assert.deepEqual(indexes, [{ index_name: KUZU_WORKSPACE_FTS_INDEX }]);
  }
};

try {
  await db.initSchema(`kuzu-conformance-${suffix}`);
  await runWorkspaceLifecycleConformance(fixture);
  process.stdout.write("kuzu workspace lifecycle scenario passed\n");
} finally {
  // Managed close only releases this wrapper. Process exit releases the native
  // Kuzu/FTS handle before the parent test removes the temporary directory.
  await db.close();
}

import fs from "node:fs/promises";
import path from "node:path";

export default {
  name: "costom-request-plugin",
  version: "0.1.0",
  pluginApiVersion: "1",
  setup(context) {
    // Helper to check if file exists
    async function fileExists(filePath) {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }

    // Helper to create an evidence node
    function createFrameworkEvidence(repoId, filePath) {
      const hashInput = [repoId, filePath, "1", "request-file-exists", `${filePath} exists`].join(":");
      // We can generate a simple unique ID or use placeholders
      const evidenceId = `evidence:framework-detect:${hashInput.replace(/[^a-zA-Z0-9]/g, "-")}`;
      const fileId = `file:${repoId}:${filePath.replace(/\\/g, "/")}`;
      return {
        id: evidenceId,
        repoId,
        fileId,
        filePath,
        line: 1,
        raw: `${filePath} exists`,
        rule: "request-file-exists",
        confidence: 1.0,
        active: true
      };
    }

    // Register a custom framework detector for custom request convention
    context.registerFrameworkDetector({
      name: "costom-detector",
      async detect(repo) {
        const results = [];
        const costomPaths = ["src/utils/request.js", "src/utils/request.ts"];
        for (const rPath of costomPaths) {
          const absolutePath = path.join(repo.path, rPath);
          if (await fileExists(absolutePath)) {
            const costomEvidence = createFrameworkEvidence(repo.id, rPath);
            results.push({
              repoId: repo.id,
              name: "js:costom-request",
              language: "javascript",
              confidence: 1.0,
              evidence: [costomEvidence]
            });
            break; // Found one, no need to continue
          }
        }
        return results;
      }
    });
  }
};

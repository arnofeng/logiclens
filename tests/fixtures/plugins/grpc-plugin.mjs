function normalizeName(input) {
  return input.trim().replace(/\\/g, "/").replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function contractId(kind, key) {
  return `contract:${normalizeName(kind)}:${normalizeName(key)}`;
}

function evidenceId(parts) {
  return `evidence:${normalizeName(parts.join(":"))}`;
}

function sourceLine(source, offset, startLine) {
  return startLine + source.slice(0, offset).split(/\r?\n/).length - 1;
}

export default {
  name: "grpc-fixture-plugin",
  version: "1.0.0",
  pluginApiVersion: "1",
  setup(context) {
    context.registerContractExtractor({
      name: "grpc-fixture-extractor",
      extract({ parsedFiles }) {
        const contractKey = "grpc:user.userservice";
        const serviceContract = {
          id: contractId("api", contractKey),
          kind: "api",
          key: contractKey,
          name: "UserService",
          description: "gRPC service user.UserService"
        };
        const contracts = [];
        const evidence = [];
        const relations = [];
        for (const file of parsedFiles) {
          if (file.language === "markdown") continue;
          for (const symbol of file.symbols) {
            const producerIndex = symbol.source.indexOf("grpc.registerService(\"user.UserService\")");
            const consumerIndex = symbol.source.indexOf("grpc.client(\"user.UserService\")");
            const matches = [
              { index: producerIndex, role: "producer", rule: "grpc-fixture-plugin/grpc-service-producer", raw: "grpc.registerService(\"user.UserService\")" },
              { index: consumerIndex, role: "consumer", rule: "grpc-fixture-plugin/grpc-service-consumer", raw: "grpc.client(\"user.UserService\")" }
            ].filter((match) => match.index >= 0);
            for (const match of matches) {
              const evidenceNode = {
                id: evidenceId([file.repoId, file.path, String(sourceLine(symbol.source, match.index, symbol.startLine)), match.rule, match.raw]),
                repoId: file.repoId,
                fileId: file.fileId,
                filePath: file.path,
                line: sourceLine(symbol.source, match.index, symbol.startLine),
                raw: match.raw,
                rule: match.rule,
                confidence: 0.95
              };
              contracts.push(serviceContract);
              evidence.push(evidenceNode);
              relations.push({
                kind: "repo-contract",
                repoId: file.repoId,
                contractId: serviceContract.id,
                role: match.role,
                evidenceId: evidenceNode.id,
                confidence: evidenceNode.confidence
              });
            }
          }
        }
        return { contracts, evidence, entities: [], operations: [], workflows: [], relations };
      }
    });
  }
};

export default {
  name: "logiclens-example-grpc-contract",
  version: "0.1.0",
  pluginApiVersion: "1",
  setup(context, options = {}) {
    const serviceName = options.serviceName ?? "user.UserService";
    context.registerContractExtractor({
      name: "example-grpc-contract-extractor",
      extract() {
        // Copy this example and return Contract/Evidence/Relation facts for your own gRPC conventions.
        return {
          contracts: [],
          evidence: [],
          entities: [],
          operations: [],
          workflows: [],
          relations: []
        };
      }
    });
    void serviceName;
  }
};

// A well-shaped plugin that declares an unsupported plugin API version.
// Used to test that importPluginModule rejects unsupported API versions.
export default {
  name: "bad-api-version-plugin",
  version: "1.0.0",
  pluginApiVersion: "2",
  setup() {}
};

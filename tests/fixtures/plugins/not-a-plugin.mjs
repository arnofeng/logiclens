// Imports successfully but does NOT export a valid LogicLensPlugin
// (no name/version/setup). Used to test that `plugin add` verification
// rejects it and does not write config.
export default {
  hello: "world"
};

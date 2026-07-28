# @logiclens/plugin-sdk

Public TypeScript contracts and utilities for authoring LogicLens language, fact-extractor, framework-detector, and resolver plugins.

## Installation

```bash
npm install @logiclens/plugin-sdk
```

Plugin API 1.x is the stable contract for LogicLens 1.x. A plugin manifest must declare a compatible `logiclensPluginApiVersion`; 0.x plugin manifests are not compatible with the 1.x runtime.

See the [Plugin SDK reference](https://github.com/arnofeng/logiclens/blob/main/docs/plugin-sdk.md) and the [official C# plugin](https://github.com/arnofeng/logiclens/tree/main/packages/plugin-csharp) for a complete implementation example.

## License

MIT

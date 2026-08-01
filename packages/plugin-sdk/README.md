# @repohelix/plugin-sdk

Public TypeScript contracts and utilities for authoring RepoHelix language, fact-extractor, framework-detector, and resolver plugins.

## Installation

```bash
npm install @repohelix/plugin-sdk
```

Plugin API 1.x is the stable contract for RepoHelix 1.x. A plugin manifest must declare a compatible `pluginApiVersion`; 0.x plugin manifests are not compatible with the 1.x runtime.

See the [Plugin SDK reference](https://github.com/arnofeng/repohelix/blob/main/docs/plugin-sdk.md) and the [official C# plugin](https://github.com/arnofeng/repohelix/tree/main/packages/plugin-csharp) for a complete implementation example.

## License

MIT

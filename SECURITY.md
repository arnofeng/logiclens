# Security Policy

## Supported Versions

Security fixes are applied to the latest LogicLens 1.x release. Pre-1.0 beta versions and Plugin API 0.x are no longer supported.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to the project maintainers before publishing details. Include:

- Affected LogicLens version or commit
- Operating system and Node.js version
- Reproduction steps or a proof of concept
- Impact assessment and any known workaround

## Dependency Audit Notes

LogicLens uses Kuzu as an embedded graph database and overrides vulnerable transitive `tar` versions when necessary. `pnpm run audit:prod` is a blocking release gate at the `high` severity level. A release must not be published while that command reports a high- or critical-severity production advisory; any temporary exception requires a documented security review and a separate repository change.

When handling untrusted repositories, run LogicLens in a least-privilege workspace and avoid indexing paths outside the intended project directory.

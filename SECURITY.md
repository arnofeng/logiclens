# Security Policy

## Supported Versions

LogicLens is currently in beta. Security fixes are applied to the latest beta release line.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to the project maintainers before publishing details. Include:

- Affected LogicLens version or commit
- Operating system and Node.js version
- Reproduction steps or a proof of concept
- Impact assessment and any known workaround

## Dependency Audit Notes

LogicLens uses Kuzu as an embedded graph database. Current production dependency audits may report high-severity advisories through the transitive chain `kuzu -> cmake-js -> tar`. The CI dependency-audit job is intentionally non-blocking while this upstream chain is reviewed, but audit output must be checked before each public release.

When handling untrusted repositories, run LogicLens in a least-privilege workspace and avoid indexing paths outside the intended project directory.

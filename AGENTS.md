# Repository Guidelines

## Project Structure & Module Organization

LogicLens is a TypeScript, ESM-based CLI and library. Core implementation lives in `src/`: `core/` contains parsing, indexing, graph, contract, semantic, and framework logic; `interfaces/` contains CLI, MCP, installer, and SDK entry points; `adapters/` contains graph database and embedding integrations; `shared/` contains reusable utilities. Workspace packages live in `packages/plugin-sdk` and `packages/plugin-runtime`. Tests are in `tests/**/*.test.ts`, with reusable samples under `tests/fixtures/` and contract-focused suites under `tests/contracts/`. Documentation lives in `docs/`, and generated build output goes to `dist/`.

## Build, Test, and Development Commands

- `pnpm install`: install root and workspace dependencies.
- `pnpm run dev -- --help`: run the CLI from `src/cli.ts` during development.
- `pnpm run build`: clean, build workspace packages, then compile the main package.
- `pnpm run build:prod`: production build using `tsconfig.prod.json`.
- `pnpm run typecheck`: run strict TypeScript checks across the root and package workspaces.
- `pnpm test`: build packages, then run the Vitest suite through `scripts/test.ts`.
- `pnpm run clean`: remove generated build artifacts.

## Coding Style & Naming Conventions

Use TypeScript with `strict` enabled and NodeNext module resolution. Prefer explicit interfaces, discriminated unions, and Zod schemas for external inputs; avoid `any` unless there is a narrow, documented reason. Follow the existing file style: two-space indentation, double quotes, semicolons, and named exports where practical. Name tests as `*.test.ts`, classes in `PascalCase`, functions and variables in `camelCase`, and constants in `UPPER_SNAKE_CASE` only for true constants.

## Testing Guidelines

Vitest discovers `tests/**/*.test.ts` and excludes `dist/` and `node_modules/`. Add focused tests near the relevant behavior, using fixtures in `tests/fixtures/` when parser or extractor behavior needs sample repositories. For changes to contracts, indexing, graph writes, or CLI behavior, run both `pnpm test` and `pnpm run typecheck` before submitting.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits, for example `feat: per-query Kuzu connections...` and `refactor: centralize shared Cypher queries...`. Use `feat:`, `fix:`, `docs:`, `test:`, or `refactor:` with a concise imperative summary. Pull requests should describe motivation, implementation, linked issues, and verification commands. Include screenshots or terminal output only when they clarify CLI behavior or documentation changes.

## Security & Configuration Tips

LogicLens is local-first. Do not add unauthorized network calls or external API dependencies in core indexing, graph, or analysis paths. Keep secrets out of source files and follow `SECURITY.md` for vulnerability reports.

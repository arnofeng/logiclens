# Contributing to LogicLens

Thank you for your interest in LogicLens! We welcome and appreciate contributions from the community, whether it's reporting bugs, improving documentation, or submitting new features.

To ensure a smooth collaboration, please read this guide before contributing.

---

## 1. Code of Conduct

We are committed to providing a friendly, safe, and welcoming environment for all participants. When participating in discussions, submitting PRs, or opening issues, please maintain mutual respect, professionalism, and objective reasoning.

---

## 2. Standard GitHub Contribution Workflow

LogicLens uses the classic GitHub Fork & Pull Request workflow. Below are the specific steps:

### Step 1: Fork the Repository

1. Visit the official LogicLens repository: `https://github.com/arnofeng/logiclens`.
2. Click the **Fork** button in the upper right corner to duplicate the repository to your own GitHub account.

### Step 2: Clone Locally

Clone your forked repository onto your local machine:

```bash
git clone https://github.com/<your-github-username>/logiclens.git
cd logiclens
```

To keep your fork in sync with the official repository, we recommend adding the official repository as a remote named `upstream`:

```bash
git remote add upstream https://github.com/arnofeng/logiclens.git
```

### Step 3: Create a Development Branch

Before making any changes, create a new branch based on the latest `main` branch from `upstream`. We suggest using descriptive branch names:

- Feature development: `feature/xxx` (e.g., `feature/rust-parser`)
- Bug fixes: `fix/xxx` (e.g., `fix/mcp-timeout`)
- Documentation updates: `docs/xxx` (e.g., `docs/update-readme`)

```bash
# Fetch and sync the latest code
git checkout main
git pull upstream main

# Create and switch to a new branch
git checkout -b feature/my-new-feature
```

### Step 4: Local Development & Build

#### Install Dependencies
Make sure you have Node.js 22 installed and Corepack enabled, then run:

```bash
corepack enable
pnpm install
```

#### Local Build
After editing TypeScript files, rebuild the project:

```bash
pnpm run build
```

#### Run CLI in Dev Mode
During local development, you do not need to `npm link`. You can run the dev version of the CLI directly using `tsx`:

```bash
# View help
pnpm run dev -- --help

# Initialize workspace in the current directory
pnpm run dev -- init
```

### Step 5: Verification & Testing

We require all submitted code to pass static checks and unit tests.

#### Type Checking (Typecheck)
Run TypeScript compiler without code generation to verify there are no compilation or type errors:

```bash
pnpm run typecheck
```

#### Run Unit Tests
Run the test suite. If you are adding a new feature or fixing a bug, please write corresponding tests in the `tests/` directory:

```bash
pnpm test
```

### Step 6: Commit Your Changes

When committing code, write clear, concise, and meaningful commit messages. We recommend following the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `feat: support FastStream contract detection in Python`
- `fix: resolve concurrency issue during Kuzu writes`
- `docs: clarify configuration options`

```bash
git add .
git commit -m "feat: brief description of your feature"
```

### Step 7: Push & Create a Pull Request

1. Push your branch to your personal GitHub fork:
   ```bash
   git push origin feature/my-new-feature
   ```
2. Go to your GitHub Fork page, and you will see a banner prompting you to open a PR.
3. Click the **Compare & pull request** button.
4. Describe your changes clearly in the PR description, outlining:
   - The motivation behind the change (linking any related issue IDs).
   - How you implemented and verified the change.
5. Once everything is verified, click **Create pull request**.

---

## 3. Code & Design Guidelines

1. **Type Safety**: LogicLens is a TypeScript project. Avoid using `any` and define strict interfaces or Zod schemas for input validation.
2. **Local-First & Privacy**: Core indexing, graph writes, and analysis must run locally. Do not introduce external API dependencies or unauthorized network calls.
3. **Maintain Documentation Integrity**: Preserve all existing comments and docstrings that are unrelated to your code changes. Include JSDoc comments for new public APIs.
4. **Performance Concerns**: When designing extractors or parsers, pay attention to memory consumption and file reading concurrency to avoid Out Of Memory (OOM) errors on large codebases.

---

## 4. Getting Help & Communication

If you have questions during development, you can reach out through the following channels:
- Submit [Issues](https://github.com/arnofeng/logiclens/issues) on GitHub.
- For security vulnerabilities, do not open public issues. Please report them privately according to the instructions in `SECURITY.md`.

Thank you for contributing to LogicLens!

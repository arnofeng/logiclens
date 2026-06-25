import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * A supported Node package manager used to install plugin packages.
 */
export type PackageManager = "npm" | "pnpm" | "yarn";

/**
 * Detects the package manager to use for a workspace by inspecting lockfiles.
 *
 * Resolution order: pnpm (`pnpm-lock.yaml`), yarn (`yarn.lock`), then npm as the
 * default when no recognized lockfile is present.
 *
 * @param cwd - The workspace directory to inspect.
 * @returns The detected package manager.
 */
export async function detectPackageManager(cwd = process.cwd()): Promise<PackageManager> {
  const exists = async (file: string): Promise<boolean> =>
    Boolean(await fs.stat(path.join(cwd, file)).catch(() => undefined));
  if (await exists("pnpm-lock.yaml")) return "pnpm";
  if (await exists("yarn.lock")) return "yarn";
  return "npm";
}

// Conservative npm package spec: optional @scope/, a package name, and an
// optional @version-or-tag. Disallows whitespace and shell metacharacters so the
// spec is safe to pass to a shell-invoked install command.
const SAFE_PACKAGE_SPEC = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.\-^~><=*]+)?$/i;

/**
 * Returns whether a package spec is a well-formed, injection-safe npm specifier
 * (e.g. `pkg`, `pkg@1.2.3`, `@scope/pkg@^1.0.0`).
 */
export function isSafePackageSpec(spec: string): boolean {
  return SAFE_PACKAGE_SPEC.test(spec);
}

function installArgs(pm: PackageManager, spec: string): string[] {
  return pm === "npm" ? ["install", spec] : ["add", spec];
}

/**
 * Installs a package into a workspace using the given package manager.
 *
 * Inherits stdio so the user sees install progress. Rejects if the spec is
 * unsafe or the package manager exits with a non-zero status.
 *
 * @param cwd - The workspace directory to install into.
 * @param spec - The package spec to install (e.g. `pkg@1.2.3`).
 * @param pm - The package manager to use.
 */
export async function installPackage(cwd: string, spec: string, pm: PackageManager): Promise<void> {
  if (!isSafePackageSpec(spec)) {
    throw new Error(`Refusing to install unsafe package spec: "${spec}".`);
  }
  const args = installArgs(pm, spec);
  await new Promise<void>((resolve, reject) => {
    // shell:true for cross-platform resolution of the package-manager binary
    // (e.g. npm.cmd on Windows). The spec is validated above to prevent injection.
    const child = spawn(pm, args, { cwd, stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${pm} ${args.join(" ")} failed with exit code ${code}.`));
    });
  });
}

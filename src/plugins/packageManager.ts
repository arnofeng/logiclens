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
 * Returns the directory of LogicLens's private, self-contained plugin store
 * for a workspace: `<cwd>/.logiclens/plugins`.
 *
 * Plugin packages are installed here rather than into the workspace (or an
 * analyzed repo) so they never pollute a user's project dependency tree, and
 * are removed together with the workspace on `uninit`.
 */
export function pluginStoreDir(cwd: string): string {
  return path.join(cwd, ".logiclens", "plugins");
}

/**
 * Ensures the plugin store directory exists with a minimal private
 * `package.json` so any package manager can install into it uniformly.
 *
 * @param cwd - The workspace directory.
 * @returns The absolute path to the plugin store directory.
 */
export async function ensurePluginStore(cwd: string): Promise<string> {
  const dir = pluginStoreDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  const manifest = path.join(dir, "package.json");
  const exists = await fs.stat(manifest).then(() => true).catch(() => false);
  if (!exists) {
    const contents = {
      name: "logiclens-plugins",
      private: true,
      version: "0.0.0",
      description: "LogicLens-managed plugin packages. Do not edit by hand."
    };
    await fs.writeFile(manifest, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  }
  return dir;
}

/**
 * Installs a package into LogicLens's private plugin store ({@link pluginStoreDir}).
 *
 * Inherits stdio so the user sees install progress. Rejects if the spec is
 * unsafe or the package manager exits with a non-zero status.
 *
 * @param cwd - The workspace directory whose plugin store receives the package.
 * @param spec - The package spec to install (e.g. `pkg@1.2.3`).
 * @param pm - The package manager to use.
 */
export async function installPackage(cwd: string, spec: string, pm: PackageManager): Promise<void> {
  if (!isSafePackageSpec(spec)) {
    throw new Error(`Refusing to install unsafe package spec: "${spec}".`);
  }
  const storeDir = await ensurePluginStore(cwd);
  const args = installArgs(pm, spec);
  await new Promise<void>((resolve, reject) => {
    // shell:true for cross-platform resolution of the package-manager binary
    // (e.g. npm.cmd on Windows). The spec is validated above to prevent injection.
    const child = spawn(pm, args, { cwd: storeDir, stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${pm} ${args.join(" ")} failed with exit code ${code}.`));
    });
  });
}

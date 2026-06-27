import { runInstallerWithOptions } from "../installer/index.js";

export type InstallCommandOptions = {
  target?: string;
  location?: "global" | "local";
  yes?: boolean;
  permissions?: boolean;
  printConfig?: string;
};

export async function installCommand(opts: InstallCommandOptions): Promise<void> {
  if (opts.printConfig) {
    const { getTarget, listTargetIds } = await import("../installer/targets/registry.js");
    const target = getTarget(opts.printConfig);
    if (!target) {
      const known = listTargetIds().join(", ");
      console.error(`Unknown target "${opts.printConfig}". Known: ${known}.`);
      process.exit(1);
    }
    const loc = opts.location || "global";
    process.stdout.write(target.printConfig(loc));
    return;
  }

  try {
    const explicitNoPermissions = opts.permissions === false;
    const autoAllow: boolean | undefined = explicitNoPermissions
      ? false
      : opts.yes
        ? true
        : undefined;

    await runInstallerWithOptions({
      target: opts.target,
      location: opts.location,
      autoAllow,
      yes: opts.yes,
    });
  } catch (err: any) {
    console.error(err.message || String(err));
    process.exit(1);
  }
}

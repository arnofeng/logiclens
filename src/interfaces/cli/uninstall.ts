import { runUninstaller } from "../installer/index.js";

export type UninstallCommandOptions = {
  target?: string;
  location?: "global" | "local";
  yes?: boolean;
};

export async function uninstallCommand(opts: UninstallCommandOptions): Promise<void> {
  try {
    await runUninstaller({
      target: opts.target,
      location: opts.location,
      yes: opts.yes,
    });
  } catch (err: any) {
    console.error(err.message || String(err));
    process.exit(1);
  }
}

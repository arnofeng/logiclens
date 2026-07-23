import { createClient } from "../sdk/client.js";

type AskRuntime = Readonly<{
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}>;

function normalizedGitRoots(env: NodeJS.ProcessEnv): string[] {
  const programFiles = [
    env.ProgramFiles,
    env.PROGRAMFILES,
    env["ProgramFiles(x86)"],
    env["PROGRAMFILES(X86)"],
    "C:/Program Files",
    "C:/Program Files (x86)"
  ];
  return [...new Set(programFiles
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => `${value.replace(/\\/gu, "/").replace(/\/+$/u, "")}/Git`))];
}

export function recoverMsysConvertedSlashTarget(
  question: string,
  runtime: AskRuntime = { platform: process.platform, env: process.env }
): string | undefined {
  if (runtime.platform !== "win32") return undefined;
  const shell = runtime.env.SHELL?.replace(/\\/gu, "/") ?? "";
  const isMsysShell = Boolean(runtime.env.MSYSTEM || runtime.env.MINGW_PREFIX || /(?:^|\/)bash(?:\.exe)?$/iu.test(shell));
  if (!isMsysShell) return undefined;

  const normalized = question.normalize("NFC").replace(/\\/gu, "/");
  const root = normalizedGitRoots(runtime.env)
    .find((candidate) => normalized.toLowerCase().startsWith(`${candidate.toLowerCase()}/`));
  if (!root) return undefined;

  const suffix = normalized.slice(root.length);
  return suffix.length > 1 ? suffix : undefined;
}

export async function askCommand(
  question: string,
  cwd = process.cwd(),
  runtime: AskRuntime = { platform: process.platform, env: process.env }
): Promise<void> {
  const recoveredTarget = recoverMsysConvertedSlashTarget(question, runtime);
  const effectiveQuestion = recoveredTarget ?? question;
  if (recoveredTarget) {
    console.warn(`Recovered Git Bash/MSYS path conversion as API target: ${recoveredTarget}`);
  }

  const client = await createClient({ cwd });
  try {
    console.log(await client.ask(effectiveQuestion));
  } finally {
    await client.close();
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath, windowsHide: true });
  return stdout.trim();
}

export async function getGitMetadata(repoPath = process.cwd()): Promise<{ remoteUrl: string; branch: string; commitSha: string }> {
  try {
    const [remoteUrl, branch, commitSha] = await Promise.all([
      git(repoPath, ["config", "--get", "remote.origin.url"]).catch(() => ""),
      git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      git(repoPath, ["rev-parse", "HEAD"]).catch(() => "")
    ]);
    return { remoteUrl, branch: branch === "HEAD" ? "" : branch, commitSha };
  } catch {
    return { remoteUrl: "", branch: "", commitSha: "" };
  }
}

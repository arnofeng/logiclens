export async function getGitMetadata(): Promise<{ remoteUrl: string; branch: string; commitSha: string }> {
  return { remoteUrl: "", branch: "", commitSha: "" };
}

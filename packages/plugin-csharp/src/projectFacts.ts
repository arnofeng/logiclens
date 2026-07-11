import { defineFactExtractor, defineFrameworkDetector } from "@logiclens/plugin-sdk";
import type { PluginEvidenceInput, PluginFrameworkFact, PluginPackageUsageFact, PluginRepoView } from "@logiclens/plugin-sdk";
import { collectProjectMetadata, type ProjectDeclaration } from "./projectMetadata.js";

type Candidate = { name: string; declaration: ProjectDeclaration; rule: string };

function evidence(declaration: ProjectDeclaration, rule: string): PluginEvidenceInput {
  return { filePath: declaration.filePath, line: declaration.line, raw: declaration.raw, rule, confidence: "exact" };
}

function stableDeclarations(declarations: readonly ProjectDeclaration[]): ProjectDeclaration[] {
  return [...declarations].sort((left, right) => left.filePath.localeCompare(right.filePath, "en") || left.line - right.line || left.name.localeCompare(right.name, "en"));
}

async function declarationsFor(repo: PluginRepoView): Promise<ProjectDeclaration[]> {
  return stableDeclarations((await collectProjectMetadata(repo.path)).flatMap((file) => file.declarations));
}

export const csharpPackageExtractor = defineFactExtractor({
  name: "csharp:project-package-usage",
  languages: ["csharp"],
  async extract(context) {
    for (const repo of context.repos) {
      const declarations = await declarationsFor(repo);
      const emitted = new Set<string>();
      for (const declaration of declarations) {
        const selected = declaration.kind === "packageReference" || declaration.kind === "frameworkReference" || (declaration.kind === "sdk" && declaration.name.toLowerCase().startsWith("microsoft.net.sdk"));
        if (!selected) continue;
        const key = declaration.name.toLowerCase();
        if (emitted.has(key)) continue;
        emitted.add(key);
        const rule = `csharp-project-${declaration.kind}`;
        const fact: Omit<PluginPackageUsageFact, "kind"> = { repoId: repo.id, filePath: declaration.filePath, packageName: declaration.name, evidence: evidence(declaration, rule) };
        context.emit.packageUsage(fact);
      }
    }
  }
});

function frameworkCandidates(declarations: readonly ProjectDeclaration[]): Candidate[] {
  const candidates: Candidate[] = [];
  const add = (name: string, declaration: ProjectDeclaration, rule: string): void => { candidates.push({ name, declaration, rule }); };
  for (const declaration of declarations) {
    const value = declaration.name.toLowerCase();
    const sdkName = value.split("/")[0]!;
    if (declaration.kind === "targetFramework") add(".NET", declaration, "csharp-target-framework");
    if (declaration.kind === "sdk" && sdkName.startsWith("microsoft.net.sdk")) add(".NET", declaration, "csharp-dotnet-sdk");
    if ((declaration.kind === "sdk" && sdkName === "microsoft.net.sdk.web") || (declaration.kind === "frameworkReference" && value === "microsoft.aspnetcore.app") || (declaration.kind === "packageReference" && value.startsWith("microsoft.aspnetcore."))) add("ASP.NET Core", declaration, "csharp-aspnet-core-project-evidence");
    if (declaration.kind === "sdk" && sdkName === "microsoft.net.sdk.worker") add("Worker Service", declaration, "csharp-worker-service-project-evidence");
    if (declaration.kind === "packageReference" && value.startsWith("microsoft.entityframeworkcore")) add("EF Core", declaration, "csharp-ef-core-package");
    if (declaration.kind === "packageReference" && value.startsWith("grpc.")) add("gRPC", declaration, "csharp-grpc-package");
    if (declaration.kind === "packageReference" && (value === "xunit" || value.startsWith("xunit."))) add("xUnit", declaration, "csharp-xunit-package");
    if (declaration.kind === "packageReference" && (value === "nunit" || value.startsWith("nunit."))) add("NUnit", declaration, "csharp-nunit-package");
    if (declaration.kind === "packageReference" && (value === "mstest" || value.startsWith("mstest."))) add("MSTest", declaration, "csharp-mstest-package");
  }
  return candidates;
}

export const csharpFrameworkDetector = defineFrameworkDetector({
  name: "csharp:project-frameworks",
  async detect(context) {
    for (const repo of context.repos) {
      const candidates = frameworkCandidates(await declarationsFor(repo));
      const grouped = new Map<string, Candidate[]>();
      for (const candidate of candidates) grouped.set(candidate.name, [...(grouped.get(candidate.name) ?? []), candidate]);
      for (const [name, matches] of grouped) {
        const seen = new Set<string>();
        const frameworkEvidence = matches.flatMap((match) => {
          const item = evidence(match.declaration, match.rule);
          const key = `${item.filePath}\0${item.line}\0${item.rule}\0${item.raw}`;
          if (seen.has(key)) return [];
          seen.add(key);
          return [item];
        });
        const fact: Omit<PluginFrameworkFact, "kind"> = { repoId: repo.id, name, language: "csharp", evidence: frameworkEvidence };
        context.emit.framework(fact);
      }
    }
  }
});

import type { GraphDB } from "../../core/graph-model/db.js";

export type QualityRuleViolation = {
  ruleId: string;
  severity: "P1" | "P2";
  description: string;
  details: string[];
  suggestedFix: string;
};

export async function auditContractQuality(
  db: GraphDB,
  options: { packageInflationLimit?: number } = {}
): Promise<QualityRuleViolation[]> {
  const packageInflationLimit = options.packageInflationLimit ?? 1000;
  const violations: QualityRuleViolation[] = [];

  // --- Rule 1: Java Class-level Package Contracts ---
  const packageContracts = await db.query<{ key: string }>(
    "MATCH (c:Contract) WHERE c.kind = 'package' RETURN c.key AS key;"
  );
  
  const commonClassNames = new Set([
    "list", "map", "set", "hashmap", "arraylist", "collection", "iterator", "string", "integer", "double", "float", "long", "boolean", "byte", "short", "character", "date", "calendar", "uuid", "file", "path", "stream"
  ]);
  const commonClassSuffixes = [
    "util", "utils", "helper", "helpers", "service", "services", "controller", "controllers", "config", "configs", "dto", "dtos", "dao", "daos", "entity", "entities", "impl", "mapper", "mappers"
  ];
  
  const classLevelPackages: string[] = [];
  for (const pkg of packageContracts) {
    const key = pkg.key;
    if (key.includes(".")) {
      const lastSegment = key.split(".").pop() || "";
      if (
        commonClassNames.has(lastSegment.toLowerCase()) ||
        commonClassSuffixes.some(suffix => lastSegment.toLowerCase().endsWith(suffix))
      ) {
        classLevelPackages.push(key);
      }
    }
  }
  
  if (classLevelPackages.length > 0) {
    violations.push({
      ruleId: "java-class-level-package",
      severity: "P1",
      description: "Java import class-level package contracts detected",
      details: classLevelPackages.sort().map(pkg => `- ${pkg}`),
      suggestedFix: "Suggested extractor: javaPackageExtractor"
    });
  }

  // --- Rule 2: API Contract Without leading slash ('/') ---
  const apiContracts = await db.query<{ key: string }>(
    "MATCH (c:Contract) WHERE c.kind = 'api' RETURN c.key AS key;"
  );
  
  const noSlashApis = apiContracts
    .map(c => c.key)
    .filter(key => !key.startsWith("/"));
    
  if (noSlashApis.length > 0) {
    violations.push({
      ruleId: "api-no-leading-slash",
      severity: "P2",
      description: "API contracts without leading slash ('/')",
      details: noSlashApis.sort().map(key => `- ${key}`),
      suggestedFix: "Ensure all extractor API paths are normalized with a leading slash."
    });
  }

  // --- Rule 3: API producer only has method path, no class base path ---
  const producers = await db.query<{ repoName: string; key: string }>(
    "MATCH (r:Repo)-[:PRODUCES]->(c:Contract) WHERE c.kind = 'api' RETURN r.name AS repoName, c.key AS key;"
  );
  
  function isMethodPathWithoutBasePath(key: string): boolean {
    const normalized = key.replace(/\{[^}]+\}/g, "param"); // e.g. /{id} -> /param
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length === 1) {
      const seg = segments[0].toLowerCase();
      const commonMethodPaths = new Set([
        "id", "param", "list", "add", "delete", "update", "query", "save", "edit", "remove", 
        "export", "import", "upload", "download", "check", "status", "config", "detail", "info", "get", "post", "put"
      ]);
      return commonMethodPaths.has(seg);
    }
    return false;
  }
  
  const methodOnlyProducers = producers
    .filter(p => isMethodPathWithoutBasePath(p.key))
    .map(p => `- ${p.key} (produced by ${p.repoName})`);
    
  if (methodOnlyProducers.length > 0) {
    violations.push({
      ruleId: "api-method-only-producer",
      severity: "P2",
      description: "API producers with method path only (no class base path)",
      details: methodOnlyProducers.sort(),
      suggestedFix: "Verify if the Controller class-level request mapping annotation was parsed."
    });
  }

  // --- Rule 4: Consumer has /smart/backorder, producer only has /smart/backorder/list ---
  const allConsumers = await db.query<{ repoName: string; key: string }>(
    "MATCH (r:Repo)-[:CONSUMES]->(c:Contract) WHERE c.kind = 'api' RETURN r.name AS repoName, c.key AS key;"
  );
  const allProducers = await db.query<{ repoName: string; key: string }>(
    "MATCH (r:Repo)-[:PRODUCES]->(c:Contract) WHERE c.kind = 'api' RETURN r.name AS repoName, c.key AS key;"
  );
  
  const producerKeys = new Set(allProducers.map(p => p.key));
  const unproducedConsumers = allConsumers.filter(c => !producerKeys.has(c.key));
  
  const missingClassMappings: string[] = [];
  for (const uc of unproducedConsumers) {
    const matchingProducers = allProducers.filter(p => p.key.startsWith(uc.key + "/"));
    if (matchingProducers.length > 0) {
      const subpathInfo = matchingProducers
        .map(p => `sub-path producer ${p.key} exists in ${p.repoName}`)
        .join(", ");
      missingClassMappings.push(`- ${uc.key} (consumed by ${uc.repoName}, ${subpathInfo})`);
    }
  }
  
  if (missingClassMappings.length > 0) {
    violations.push({
      ruleId: "api-missing-class-level-mapping",
      severity: "P1",
      description: "Consumer API has no producer but matching sub-paths exist",
      details: missingClassMappings.sort(),
      suggestedFix: "Verify class-level request mapping or routing configuration."
    });
  }

  // --- Rule 5: Same API appears with case variants ---
  const apiKeys = apiContracts.map(c => c.key);
  const keyGroups = new Map<string, string[]>();
  for (const key of apiKeys) {
    const lower = key.toLowerCase();
    const group = keyGroups.get(lower) ?? [];
    group.push(key);
    keyGroups.set(lower, group);
  }
  
  const caseVariants: string[] = [];
  for (const [lower, group] of keyGroups.entries()) {
    if (group.length > 1) {
      const unique = [...new Set(group)];
      if (unique.length > 1) {
        caseVariants.push(...unique);
      }
    }
  }
  
  if (caseVariants.length > 0) {
    violations.push({
      ruleId: "api-case-variations",
      severity: "P2",
      description: "Duplicate API contracts with case variations",
      details: caseVariants.sort().map(key => `- ${key}`),
      suggestedFix: "Normalize API paths to lowercase or consistent case."
    });
  }

  // --- Rule 6: Package contract inflation (> 1000) ---
  const repoPackages = await db.query<{ repoName: string; count: number }>(
    "MATCH (r:Repo)-[:OWNS_PACKAGE]->(c:Contract) RETURN r.name AS repoName, count(c) AS count;"
  );
  
  const inflatedRepos = repoPackages
    .filter(rp => Number(rp.count) > packageInflationLimit)
    .map(rp => `- ${rp.repoName} (${rp.count} package contracts)`);
    
  if (inflatedRepos.length > 0) {
    violations.push({
      ruleId: "package-contract-inflation",
      severity: "P2",
      description: `Abnormally inflated package contract count (> ${packageInflationLimit})`,
      details: inflatedRepos.sort(),
      suggestedFix: "Verify package extractor filters or scope."
    });
  }

  return violations;
}

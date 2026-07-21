export const NEO4J_INTEGRATION_ENV = Object.freeze({
  enabled: "LOGICLENS_RUN_NEO4J_INTEGRATION",
  url: "LOGICLENS_TEST_NEO4J_URL",
  username: "LOGICLENS_TEST_NEO4J_USERNAME",
  password: "LOGICLENS_TEST_NEO4J_PASSWORD",
  database: "LOGICLENS_TEST_NEO4J_DATABASE",
  ephemeral: "LOGICLENS_TEST_NEO4J_EPHEMERAL",
} as const);

export interface Neo4jTestConfiguration {
  url: string;
  username: string;
  password: string;
  database: string;
  ephemeral: boolean;
}

export interface Neo4jTestEnvironment {
  enabled: boolean;
  runnable: boolean;
  testName: string;
  requireConfiguration(): Neo4jTestConfiguration;
}

export interface Neo4jCleanupStep {
  name: string;
  run(): unknown | Promise<unknown>;
}

const REQUIRED_KEYS = ["url", "username", "password", "database"] as const;
const SHARED_DATABASES = new Set(["neo4j", "system"]);

export function resolveNeo4jTestEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Neo4jTestEnvironment {
  const enabled = environment[NEO4J_INTEGRATION_ENV.enabled]?.trim() === "1";
  const values = Object.fromEntries(REQUIRED_KEYS.map((key) => [
    key,
    environment[NEO4J_INTEGRATION_ENV[key]]?.trim() ?? "",
  ])) as Record<(typeof REQUIRED_KEYS)[number], string>;
  const missing = REQUIRED_KEYS.filter((key) => values[key].length === 0)
    .map((key) => NEO4J_INTEGRATION_ENV[key]);
  const ephemeral = environment[NEO4J_INTEGRATION_ENV.ephemeral]?.trim() === "1";
  const normalizedDatabase = values.database.toLowerCase();
  const unsafeDatabase = normalizedDatabase === "system"
    || (normalizedDatabase === "neo4j" && !ephemeral);

  let reason: string;
  if (!enabled) {
    reason = `not enabled (${NEO4J_INTEGRATION_ENV.enabled}=1 required)`;
  } else if (missing.length > 0) {
    reason = `missing ${missing.join(", ")}`;
  } else if (unsafeDatabase) {
    reason = normalizedDatabase === "system"
      ? "shared database is forbidden (system)"
      : `shared/default database requires ${NEO4J_INTEGRATION_ENV.ephemeral}=1`;
  } else {
    reason = "configuration accepted";
  }

  const runnable = enabled && missing.length === 0 && !unsafeDatabase;
  return {
    enabled,
    runnable,
    testName: runnable
      ? "runs against an explicitly enabled isolated Neo4j test database"
      : `Neo4j integration ${enabled ? "configuration invalid" : "skipped"}: ${reason}`,
    requireConfiguration() {
      if (!enabled) throw new Error(`Neo4j integration is not enabled: ${reason}.`);
      if (!runnable) throw new Error(`Unsafe or incomplete Neo4j integration configuration: ${reason}.`);
      return {
        url: values.url,
        username: values.username,
        password: values.password,
        database: values.database,
        ephemeral,
      };
    },
  };
}

export function isSharedNeo4jDatabase(database: string): boolean {
  return SHARED_DATABASES.has(database.trim().toLowerCase());
}

/** Executes every cleanup step and reports all failures after resources had a chance to close. */
export async function runNeo4jCleanupSteps(steps: readonly Neo4jCleanupStep[]): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(new Error(`Neo4j cleanup step failed: ${step.name}`, { cause: error }));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Neo4j cleanup failed in ${failures.length} step(s).`);
  }
}

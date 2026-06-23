import { setTimeout as sleepMs } from "node:timers/promises";

export type ProviderFailureKind = "rate-limited" | "transient-failed" | "permanent-failed" | "budget-exhausted";

export type ProviderRetryPolicy = {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  timeoutMs?: number;
};

export type ProviderBudgetPolicy = {
  maxRequests?: number;
  maxEstimatedTokens?: number;
  maxElapsedMs?: number;
  maxFailures?: number;
};

export type ProviderRateLimitPolicy = {
  minDelayMs?: number;
};

export type ProviderPolicy = {
  retry?: ProviderRetryPolicy;
  budget?: ProviderBudgetPolicy;
  rateLimit?: ProviderRateLimitPolicy;
};

export type ProviderCallStats = {
  requests: number;
  attempts: number;
  retries: number;
  rateLimited: number;
  transientFailures: number;
  permanentFailures: number;
  budgetExhausted: number;
  finalFailures: number;
  estimatedTokens: number;
};

export class ProviderCallError extends Error {
  readonly kind: ProviderFailureKind;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(message: string, kind: ProviderFailureKind, options: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = "ProviderCallError";
    this.kind = kind;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export type ProviderCallRuntime = {
  policy: {
    retry: Required<ProviderRetryPolicy>;
    budget: ProviderBudgetPolicy;
    rateLimit: Required<ProviderRateLimitPolicy>;
  };
  stats: ProviderCallStats;
  startedAt: number;
  lastRequestAt: number;
  gate: Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const DEFAULT_RETRY: Required<ProviderRetryPolicy> = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 8000,
  jitterRatio: 0.2,
  timeoutMs: 60000
};

const DEFAULT_BUDGET: ProviderBudgetPolicy = {};
const DEFAULT_RATE_LIMIT: Required<ProviderRateLimitPolicy> = {
  minDelayMs: 0
};

export function createProviderCallStats(): ProviderCallStats {
  return {
    requests: 0,
    attempts: 0,
    retries: 0,
    rateLimited: 0,
    transientFailures: 0,
    permanentFailures: 0,
    budgetExhausted: 0,
    finalFailures: 0,
    estimatedTokens: 0
  };
}

export function createProviderCallRuntime(
  policy: ProviderPolicy = {},
  overrides: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}
): ProviderCallRuntime {
  return {
    policy: {
      retry: { ...DEFAULT_RETRY, ...(policy.retry ?? {}) },
      budget: { ...DEFAULT_BUDGET, ...(policy.budget ?? {}) },
      rateLimit: { ...DEFAULT_RATE_LIMIT, ...(policy.rateLimit ?? {}) }
    },
    stats: createProviderCallStats(),
    startedAt: (overrides.now ?? Date.now)(),
    lastRequestAt: 0,
    gate: Promise.resolve(),
    sleep: overrides.sleep ?? sleepMs,
    now: overrides.now ?? Date.now
  };
}

export function formatProviderStats(label: string, stats: ProviderCallStats): string | undefined {
  if (
    stats.retries === 0 &&
    stats.rateLimited === 0 &&
    stats.transientFailures === 0 &&
    stats.permanentFailures === 0 &&
    stats.budgetExhausted === 0 &&
    stats.finalFailures === 0
  ) return undefined;
  return `${label} provider stats: requests=${stats.requests} attempts=${stats.attempts} retries=${stats.retries} rateLimited=${stats.rateLimited} transientFailures=${stats.transientFailures} permanentFailures=${stats.permanentFailures} budgetExhausted=${stats.budgetExhausted} finalFailures=${stats.finalFailures} estimatedTokens=${stats.estimatedTokens}`;
}

export function estimatedTokensFromText(input: string | string[]): number {
  const chars = Array.isArray(input) ? input.reduce((sum, text) => sum + text.length, 0) : input.length;
  return Math.max(1, Math.ceil(chars / 4));
}

function statusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.code === "number") return candidate.code;
  return undefined;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyProviderError(error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  const status = statusFromError(error);
  const message = messageFromError(error);
  if (status === 429) return new ProviderCallError(message, "rate-limited", { status, cause: error });
  if (status === 408 || status === 409 || (typeof status === "number" && status >= 500)) {
    return new ProviderCallError(message, "transient-failed", { status, cause: error });
  }
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return new ProviderCallError(message, "permanent-failed", { status, cause: error });
  }
  if (/timeout|timed out|econnreset|econnrefused|enotfound|network/i.test(message)) {
    return new ProviderCallError(message, "transient-failed", { status, cause: error });
  }
  return new ProviderCallError(message, "permanent-failed", { status, cause: error });
}

function recordFailure(stats: ProviderCallStats, error: ProviderCallError): void {
  if (error.kind === "rate-limited") stats.rateLimited += 1;
  else if (error.kind === "transient-failed") stats.transientFailures += 1;
  else if (error.kind === "permanent-failed") stats.permanentFailures += 1;
  else if (error.kind === "budget-exhausted") stats.budgetExhausted += 1;
}

function retryDelayMs(attempt: number, retry: Required<ProviderRetryPolicy>): number {
  const exponential = Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential * retry.jitterRatio * Math.random();
  return Math.round(exponential + jitter);
}

async function enforceRateLimit(runtime: ProviderCallRuntime): Promise<void> {
  const minDelayMs = runtime.policy.rateLimit.minDelayMs;
  if (minDelayMs <= 0 || runtime.lastRequestAt === 0) return;
  const elapsed = runtime.now() - runtime.lastRequestAt;
  if (elapsed < minDelayMs) await runtime.sleep(minDelayMs - elapsed);
}

async function reserveProviderBudget(runtime: ProviderCallRuntime, estimatedTokens: number): Promise<void> {
  const previous = runtime.gate;
  let release!: () => void;
  runtime.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    checkBudget(runtime, estimatedTokens);
    runtime.stats.requests += 1;
    runtime.stats.estimatedTokens += estimatedTokens;
  } finally {
    release();
  }
}

async function reserveProviderAttempt(runtime: ProviderCallRuntime): Promise<void> {
  const previous = runtime.gate;
  let release!: () => void;
  runtime.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    await enforceRateLimit(runtime);
    runtime.stats.attempts += 1;
    runtime.lastRequestAt = runtime.now();
  } finally {
    release();
  }
}

function checkBudget(runtime: ProviderCallRuntime, estimatedTokens: number): void {
  const budget = runtime.policy.budget;
  if (budget.maxElapsedMs !== undefined && runtime.now() - runtime.startedAt > budget.maxElapsedMs) {
    throw new ProviderCallError(`Provider budget exhausted: maxElapsedMs=${budget.maxElapsedMs}`, "budget-exhausted");
  }
  if (budget.maxRequests !== undefined && runtime.stats.requests + 1 > budget.maxRequests) {
    throw new ProviderCallError(`Provider budget exhausted: maxRequests=${budget.maxRequests}`, "budget-exhausted");
  }
  if (budget.maxEstimatedTokens !== undefined && runtime.stats.estimatedTokens + estimatedTokens > budget.maxEstimatedTokens) {
    throw new ProviderCallError(`Provider budget exhausted: maxEstimatedTokens=${budget.maxEstimatedTokens}`, "budget-exhausted");
  }
  if (budget.maxFailures !== undefined && runtime.stats.finalFailures >= budget.maxFailures) {
    throw new ProviderCallError(`Provider budget exhausted: maxFailures=${budget.maxFailures}`, "budget-exhausted");
  }
}

async function withTimeout<T>(label: string, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  if (timeoutMs <= 0) return fn(controller.signal);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(controller.signal),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new ProviderCallError(`${label} timed out after ${timeoutMs}ms`, "transient-failed"));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runProviderCall<T>(input: {
  label: string;
  runtime?: ProviderCallRuntime;
  policy?: ProviderPolicy;
  estimatedTokens?: number;
  fn: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const runtime = input.runtime ?? createProviderCallRuntime(input.policy);
  const estimatedTokens = input.estimatedTokens ?? 1;
  const retry = runtime.policy.retry;
  let attempt = 0;
  let budgetReserved = false;

  while (true) {
    attempt += 1;
    try {
      if (!budgetReserved) {
        await reserveProviderBudget(runtime, estimatedTokens);
        budgetReserved = true;
      }
      await reserveProviderAttempt(runtime);
      return await withTimeout(input.label, retry.timeoutMs, input.fn);
    } catch (error) {
      const classified = classifyProviderError(error);
      recordFailure(runtime.stats, classified);
      const retryable = classified.kind === "rate-limited" || classified.kind === "transient-failed";
      if (!retryable || attempt > retry.maxRetries) {
        runtime.stats.finalFailures += 1;
        throw classified;
      }
      runtime.stats.retries += 1;
      await runtime.sleep(retryDelayMs(attempt, retry));
    }
  }
}

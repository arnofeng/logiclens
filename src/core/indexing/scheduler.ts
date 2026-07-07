export type IndexJobStatus = "pending" | "running" | "succeeded" | "failed";

export type IndexJob<T> = {
  id: string;
  payload: T;
  attempts: number;
  status: IndexJobStatus;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type IndexQueueOptions = {
  concurrency: number;
  retries?: number;
};

export type IndexQueueSource = "manual" | "watch" | "catch-up" | "sdk" | "unknown";

export type IndexQueueJobSnapshot = {
  id: string;
  source: IndexQueueSource;
  label: string;
  status: "pending" | "running" | "succeeded" | "failed";
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  stuck?: boolean;
};

export type IndexQueueStatusSnapshot = {
  running: boolean;
  runningJob?: IndexQueueJobSnapshot;
  pendingJobs: IndexQueueJobSnapshot[];
  completedJobs: number;
  failedJobs: number;
  lastCompletedJob?: IndexQueueJobSnapshot;
  lastFailedJob?: IndexQueueJobSnapshot;
};

type EnqueuedIndexJob = IndexQueueJobSnapshot;

export class SingleProcessIndexQueue {
  private nextId = 1;
  private pending: EnqueuedIndexJob[] = [];
  private runningJob?: EnqueuedIndexJob;
  private completedJobs = 0;
  private failedJobs = 0;
  private lastCompletedJob?: IndexQueueJobSnapshot;
  private lastFailedJob?: IndexQueueJobSnapshot;
  private tail: Promise<void> = Promise.resolve();
  private timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 300000; // 5 minutes default
  }

  enqueue<T>(input: { source: IndexQueueSource; label: string; run: () => Promise<T> }): Promise<T> {
    const job: EnqueuedIndexJob = {
      id: `index:${this.nextId++}`,
      source: input.source,
      label: input.label,
      status: "pending",
      queuedAt: new Date().toISOString()
    };
    this.pending.push(job);

    const result = this.tail.then(() => this.runJob(job, input.run));
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async onIdle(): Promise<void> {
    await this.tail;
  }

  getStatus(): IndexQueueStatusSnapshot {
    let runningJobSnapshot: IndexQueueJobSnapshot | undefined;
    if (this.runningJob) {
      runningJobSnapshot = { ...this.runningJob };
      if (runningJobSnapshot.startedAt) {
        const elapsed = Date.now() - new Date(runningJobSnapshot.startedAt).getTime();
        if (elapsed > this.timeoutMs) {
          runningJobSnapshot.stuck = true;
        }
      }
    }

    return {
      running: Boolean(this.runningJob),
      runningJob: runningJobSnapshot,
      pendingJobs: this.pending.map((job) => ({ ...job })),
      completedJobs: this.completedJobs,
      failedJobs: this.failedJobs,
      lastCompletedJob: this.lastCompletedJob ? { ...this.lastCompletedJob } : undefined,
      lastFailedJob: this.lastFailedJob ? { ...this.lastFailedJob } : undefined
    };
  }

  private async runJob<T>(job: EnqueuedIndexJob, run: () => Promise<T>): Promise<T> {
    this.pending = this.pending.filter((item) => item !== job);
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.runningJob = job;
    let timer: NodeJS.Timeout | undefined;
    try {
      timer = setTimeout(() => {
        job.stuck = true;
        console.warn(`[WARNING] Job '${job.id}' (${job.label}) has been running for longer than ${this.timeoutMs}ms and may be stuck.`);
      }, this.timeoutMs);
      const result = await run();
      job.status = "succeeded";
      job.finishedAt = new Date().toISOString();
      this.completedJobs += 1;
      this.lastCompletedJob = { ...job };
      return result;
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      this.failedJobs += 1;
      this.lastFailedJob = { ...job };
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.runningJob === job) this.runningJob = undefined;
    }
  }
}

export async function runIndexQueue<T>(
  payloads: T[],
  options: IndexQueueOptions,
  worker: (payload: T, job: IndexJob<T>) => Promise<void>,
  idForPayload: (payload: T, index: number) => string = (_payload, index) => `job:${index}`
): Promise<IndexJob<T>[]> {
  const jobs = payloads.map((payload, index): IndexJob<T> => ({
    id: idForPayload(payload, index),
    payload,
    attempts: 0,
    status: "pending"
  }));
  const concurrency = Math.max(1, options.concurrency);
  let cursor = 0;
  let hasFailed = false;

  async function runNext(): Promise<void> {
    while (cursor < jobs.length && !hasFailed) {
      const job = jobs[cursor++]!;
      const maxAttempts = 1 + (options.retries ?? 0);
      while (job.attempts < maxAttempts && !hasFailed) {
        job.attempts += 1;
        job.status = "running";
        job.startedAt = new Date().toISOString();
        try {
          await worker(job.payload, job);
          job.status = "succeeded";
          job.finishedAt = new Date().toISOString();
          break;
        } catch (error) {
          job.error = error instanceof Error ? error.message : String(error);
          if (job.attempts >= maxAttempts) {
            job.status = "failed";
            job.finishedAt = new Date().toISOString();
            hasFailed = true;
            break;
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => runNext()));

  if (hasFailed) {
    for (const job of jobs) {
      if (job.status === "pending") {
        job.status = "failed";
        job.error = "Aborted due to preceding failure";
        job.finishedAt = new Date().toISOString();
      }
    }
  }

  return jobs;
}

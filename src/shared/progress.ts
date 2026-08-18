export type ProgressEvent = {
  current: number;
  total: number;
  label?: string;
};

export type ProgressReporter = (event: ProgressEvent) => void;

export type ProgressBarHandle = {
  tick(label?: string): void;
  update(current: number, label?: string, total?: number, stepMs?: number): void;
  complete(label?: string): void;
  reporter(): ProgressReporter;
};

export type ProgressBarFactory = (label: string, total: number) => ProgressBarHandle;

function terminalColumns(): number {
  const columns = process.stderr.columns;
  return typeof columns === "number" && columns > 0 ? columns : 120;
}

function fitLineToTerminal(line: string): string {
  const columns = terminalColumns();
  const maxLength = Math.max(20, columns - 1);
  if (line.length <= maxLength) return line;
  if (maxLength <= 3) return line.slice(0, maxLength);
  return `${line.slice(0, maxLength - 3)}...`;
}

export class ProgressBar {
  private current = 0;
  private lastLineLength = 0;
  private lastLoggedBucket = -1;
  private readonly started = Date.now();
  private readonly interactive = Boolean(process.stderr.isTTY && !process.env.CI);
  private lastStepMs?: number;
  private completedAt?: number;
  private finalized = false;

  constructor(
    private readonly label: string,
    private total: number
  ) {}

  reporter(): ProgressReporter {
    return (event) => this.update(event.current, event.label, event.total);
  }

  tick(label?: string): void {
    this.update(this.current + 1, label);
  }

  update(current: number, label?: string, total = this.total, stepMs = this.lastStepMs): void {
    this.total = total;
    this.current = Math.min(current, total);
    this.lastStepMs = stepMs;
    if (total <= 0) return;
    const isComplete = this.current >= total;
    if (isComplete && this.completedAt === undefined) this.completedAt = Date.now();
    const percent = Math.floor((this.current / total) * 100);
    if (!this.interactive) {
      const bucket = Math.floor(percent / 10);
      if (bucket !== this.lastLoggedBucket || this.current === total) {
        this.lastLoggedBucket = bucket;
        const stepStr = stepMs !== undefined ? `(${(stepMs / 1000).toFixed(1)}s) ` : "";
        const elapsed = ((this.elapsedMs()) / 1000).toFixed(1);
        process.stderr.write(`${this.label}: ${percent}% (${this.current}/${total})${label ? ` ${label}` : ""} [${stepStr}${elapsed}s elapsed]\n`);
      }
      return;
    }
    if (this.finalized) return;
    this.render(label, total);
    if (isComplete) this.finalizeInteractiveLine();
  }

  complete(label = "done"): void {
    if (this.finalized) return;
    this.update(this.total, label);
  }

  private render(label: string | undefined, total: number): void {
    const width = 32;
    const ratio = total === 0 ? 1 : this.current / total;
    const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
    const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
    const elapsed = (this.elapsedMs() / 1000).toFixed(1);
    const stepStr = this.lastStepMs !== undefined ? `${(this.lastStepMs / 1000).toFixed(1)}s / ` : "";
    const suffix = label ? ` ${label}` : "";
    const line = fitLineToTerminal(`${this.label} [${bar}] ${this.current}/${total} ${Math.round(ratio * 100)}% ${stepStr}${elapsed}s${suffix}`);
    const padding = this.lastLineLength > line.length ? " ".repeat(this.lastLineLength - line.length) : "";
    process.stderr.write(`\r\x1b[2K${line}${padding}`);
    this.lastLineLength = line.length + padding.length;
  }

  private finalizeInteractiveLine(): void {
    if (this.finalized) return;
    process.stderr.write("\n");
    this.finalized = true;
  }

  private elapsedMs(): number {
    return (this.completedAt ?? Date.now()) - this.started;
  }
}

type RepositoryPreparationState = {
  active: boolean;
  completed: boolean;
  filesCurrent: number;
  filesTotal: number;
};

/**
 * Collapses concurrently active repository file bars into one terminal-owned
 * progress line. Other per-repository bars stay silent during preparation so
 * independent renderers cannot erase each other's output.
 */
export class RepositoryPreparationProgress {
  private readonly progress?: ProgressBarHandle;
  private readonly states: Map<string, RepositoryPreparationState>;

  constructor(createProgressBar: ProgressBarFactory | undefined, repoNames: readonly string[]) {
    this.states = new Map(repoNames.map((repoName) => [repoName, {
      active: false,
      completed: false,
      filesCurrent: 0,
      filesTotal: 0
    }]));
    this.progress = createProgressBar?.("Repository preparation", repoNames.length);
    this.render();
  }

  startRepo(repoName: string): ProgressBarFactory {
    const state = this.requireState(repoName);
    state.active = true;
    this.render();
    return (label, total) => {
      if (!label.startsWith("Files ")) return silentProgressBar();
      state.filesTotal = total;
      state.filesCurrent = 0;
      this.render();
      return {
        tick: () => {
          state.filesCurrent = Math.min(state.filesCurrent + 1, state.filesTotal);
          this.render();
        },
        update: (current, _label, nextTotal = state.filesTotal) => {
          state.filesTotal = nextTotal;
          state.filesCurrent = Math.min(current, nextTotal);
          this.render();
        },
        complete: () => {
          state.filesCurrent = state.filesTotal;
          this.render();
        },
        reporter: () => (event) => {
          state.filesTotal = event.total;
          state.filesCurrent = Math.min(event.current, event.total);
          this.render();
        }
      };
    };
  }

  completeRepo(repoName: string): void {
    const state = this.requireState(repoName);
    state.active = false;
    state.completed = true;
    state.filesCurrent = state.filesTotal;
    this.render();
  }

  finish(failedCount = 0): void {
    if (failedCount > 0) this.progress?.complete(`failed=${failedCount}`);
  }

  private requireState(repoName: string): RepositoryPreparationState {
    const state = this.states.get(repoName);
    if (!state) throw new Error(`Unknown repository preparation progress: ${repoName}`);
    return state;
  }

  private render(): void {
    if (!this.progress) return;
    const states = [...this.states.values()];
    const active = states.filter((state) => state.active).length;
    const completed = states.filter((state) => state.completed).length;
    const filesCurrent = states.reduce((total, state) => total + state.filesCurrent, 0);
    const filesTotal = states.reduce((total, state) => total + state.filesTotal, 0);
    const files = filesTotal > 0 ? ` files=${filesCurrent}/${filesTotal}` : "";
    this.progress.update(
      completed,
      `active=${active} completed=${completed}/${states.length}${files}`,
      states.length
    );
  }
}

function silentProgressBar(): ProgressBarHandle {
  return {
    tick: () => {},
    update: () => {},
    complete: () => {},
    reporter: () => () => {}
  };
}

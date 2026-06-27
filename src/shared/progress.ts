export type ProgressEvent = {
  current: number;
  total: number;
  label?: string;
};

export type ProgressReporter = (event: ProgressEvent) => void;

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
    const percent = Math.floor((this.current / total) * 100);
    if (!this.interactive) {
      const bucket = Math.floor(percent / 10);
      if (bucket !== this.lastLoggedBucket || this.current === total) {
        this.lastLoggedBucket = bucket;
        const stepStr = stepMs !== undefined ? `(${(stepMs / 1000).toFixed(1)}s) ` : "";
        process.stderr.write(`${this.label}: ${percent}% (${this.current}/${total})${label ? ` ${label}` : ""} [${stepStr}elapsed]\n`);
      }
      return;
    }
    this.render(label, total);
  }

  complete(label = "done"): void {
    this.update(this.total, label);
    if (this.interactive) process.stderr.write("\n");
  }

  private render(label: string | undefined, total: number): void {
    const width = 32;
    const ratio = total === 0 ? 1 : this.current / total;
    const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
    const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
    const elapsed = ((Date.now() - this.started) / 1000).toFixed(1);
    const stepStr = this.lastStepMs !== undefined ? `${(this.lastStepMs / 1000).toFixed(1)}s / ` : "";
    const suffix = label ? ` ${label}` : "";
    const line = fitLineToTerminal(`${this.label} [${bar}] ${this.current}/${total} ${Math.round(ratio * 100)}% ${stepStr}${elapsed}s${suffix}`);
    const padding = this.lastLineLength > line.length ? " ".repeat(this.lastLineLength - line.length) : "";
    process.stderr.write(`\r\x1b[2K${line}${padding}`);
    this.lastLineLength = line.length + padding.length;
  }
}

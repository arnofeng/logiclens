import fs from "node:fs/promises";
import path from "node:path";
import pino from "pino";

export const logger = pino({
  level: process.env.LOGICLENS_LOG_LEVEL ?? "warn",
  transport: process.env.LOGICLENS_LOG_PRETTY ? { target: "pino-pretty" } : undefined
});

export async function writeErrorLog(operation: string, error: unknown, cwd = process.cwd()): Promise<void> {
  try {
    const logsDir = path.resolve(cwd, ".logiclens/logs");
    await fs.mkdir(logsDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    const logContent = `[${timestamp}] [${operation}] Error:\n${message}\n\n`;
    await fs.appendFile(path.join(logsDir, "error.log"), logContent, "utf8");
  } catch (e) {
    console.error("Failed to write to error log file:", e);
  }
}

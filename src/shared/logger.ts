import fs from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { BRAND_PATHS, getBrandedEnv } from "./branding.js";

export const logger = pino({
  level: getBrandedEnv("LOG_LEVEL") ?? "warn",
  transport: getBrandedEnv("LOG_PRETTY") ? { target: "pino-pretty" } : undefined
});

export async function writeErrorLog(operation: string, error: unknown, cwd = process.cwd()): Promise<void> {
  try {
    const logsDir = path.resolve(cwd, BRAND_PATHS.logs);
    await fs.mkdir(logsDir, { recursive: true });
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    const logContent = `[${timestamp}] [${operation}] Error:\n${message}\n\n`;
    await fs.appendFile(path.join(logsDir, "error.log"), logContent, "utf8");
  } catch (e) {
    console.error("Failed to write to error log file:", e);
  }
}

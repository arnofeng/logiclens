import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

console.log(`Cleaning dist directory: ${distDir}`);

try {
  fs.rmSync(distDir, { recursive: true, force: true });
  console.log("Clean completed successfully.");
} catch (error) {
  console.error("Failed to clean dist directory:", error);
  process.exit(1);
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../dist/cli.js");

if (!fs.existsSync(cliPath)) {
  console.error("This package is not built. Run `npm run build` before using the local package.");
  process.exit(1);
}

await import(pathToFileURL(cliPath).href);

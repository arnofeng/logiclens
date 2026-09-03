export type IndexOptions = {
  repo?: string;
  repos?: string[];
  changedOnly?: boolean;
  maxFiles?: number;
  batchSize?: number;
  writeMode?: "auto" | "merge" | "bulk" | "bulk-upsert";
};

export type IndexLogger = {
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (...args: any[]) => void;
  writeStderr?: (msg: string) => void;
  createProgressBar?: (label: string, total: number) => any;
};

export type IndexResult = {
  filesScanned: number;
  filesChanged: number;
  codeNodes: number;
  sectionNodes: number;
  callEdges: number;
  importEdges: number;
  entities: number;
  durationMs: number;
};

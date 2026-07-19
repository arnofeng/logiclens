export const RETRIEVE_OPTION_LIMITS = Object.freeze({
  topK: Object.freeze({ min: 1, max: 100 }),
  graphHops: Object.freeze({ min: 0, max: 5 }),
  contextBudget: Object.freeze({ min: 256, max: 65_536 }),
});

export const DEFAULT_RETRIEVE_OPTIONS = Object.freeze({
  lexical: true,
  semantic: true,
  topK: 20,
  graphHops: 1,
  contextBudget: 16_000,
});

export type RetrieveOptions = Readonly<{
  lexical?: boolean;
  semantic?: boolean;
  topK?: number;
  graphHops?: number;
  contextBudget?: number;
}>;

export type AskOptions = RetrieveOptions;

export type NormalizedRetrieveOptions = Readonly<{
  lexical: boolean;
  semantic: boolean;
  topK: number;
  graphHops: number;
  contextBudget: number;
}>;

const OPTION_KEYS = new Set(Object.keys(DEFAULT_RETRIEVE_OPTIONS));

function integerInRange(
  value: unknown,
  name: keyof typeof RETRIEVE_OPTION_LIMITS,
): number {
  const bounds = RETRIEVE_OPTION_LIMITS[name];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    throw new TypeError(
      `${name} must be a finite integer between ${bounds.min} and ${bounds.max}.`,
    );
  }
  return value;
}

export function normalizeRetrieveOptions(
  options: RetrieveOptions = {},
): NormalizedRetrieveOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Retrieve options must be an object.");
  }
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw new TypeError(`Unknown retrieve option: ${key}.`);
  }
  if (options.lexical !== undefined && typeof options.lexical !== "boolean") {
    throw new TypeError("lexical must be a boolean.");
  }
  if (options.semantic !== undefined && typeof options.semantic !== "boolean") {
    throw new TypeError("semantic must be a boolean.");
  }
  return Object.freeze({
    lexical: options.lexical ?? DEFAULT_RETRIEVE_OPTIONS.lexical,
    semantic: options.semantic ?? DEFAULT_RETRIEVE_OPTIONS.semantic,
    topK: options.topK === undefined
      ? DEFAULT_RETRIEVE_OPTIONS.topK
      : integerInRange(options.topK, "topK"),
    graphHops: options.graphHops === undefined
      ? DEFAULT_RETRIEVE_OPTIONS.graphHops
      : integerInRange(options.graphHops, "graphHops"),
    contextBudget: options.contextBudget === undefined
      ? DEFAULT_RETRIEVE_OPTIONS.contextBudget
      : integerInRange(options.contextBudget, "contextBudget"),
  });
}

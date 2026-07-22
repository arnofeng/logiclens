export type DubboXmlEntry = {
  kind: "service" | "reference";
  interfaceName: string;
  id?: string;
  ref?: string;
  group?: string;
  version?: string;
  methods: Array<{
    name: string;
    raw: string;
    offset: number;
  }>;
  raw: string;
  offset: number;
};

export function parseDubboXmlConfig(source: string): DubboXmlEntry[] {
  if (!/<(?:\w+:)?beans[\s\S]*\bdubbo\b/i.test(source) && !/<dubbo:(service|reference)\b/i.test(source)) {
    return [];
  }

  const entries: DubboXmlEntry[] = [];
  const searchable = maskXmlComments(source);
  const tagPattern = /<dubbo:(service|reference)\b([^>]*)>/gi;
  for (const match of searchable.matchAll(tagPattern)) {
    const kind = match[1] as "service" | "reference";
    const rawAttrs = match[2] ?? "";
    const attrs = parseAttributes(rawAttrs);
    const interfaceName = attrs.get("interface");
    if (!interfaceName) continue;
    const offset = match.index ?? 0;
    const openingRaw = source.slice(offset, offset + match[0].length);
    const selfClosing = /\/\s*>$/.test(match[0]);
    const methods = selfClosing
      ? []
      : parseNestedMethods(source, searchable, kind, offset + match[0].length);
    entries.push({
      kind,
      interfaceName,
      id: attrs.get("id"),
      ref: attrs.get("ref"),
      group: attrs.get("group"),
      version: attrs.get("version"),
      methods,
      raw: openingRaw,
      offset
    });
  }
  return entries;
}

function maskXmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function parseNestedMethods(
  source: string,
  searchable: string,
  kind: DubboXmlEntry["kind"],
  bodyOffset: number
): DubboXmlEntry["methods"] {
  const closingPattern = new RegExp(`<\\/dubbo:${kind}\\s*>`, "gi");
  closingPattern.lastIndex = bodyOffset;
  const closing = closingPattern.exec(searchable);
  if (!closing) return [];

  const body = searchable.slice(bodyOffset, closing.index);
  const methods: DubboXmlEntry["methods"] = [];
  const methodPattern = /<dubbo:method\b([^>]*)\/?>/gi;
  for (const match of body.matchAll(methodPattern)) {
    const attrs = parseAttributes(match[1] ?? "");
    const name = attrs.get("name")?.trim();
    if (!name) continue;
    const offset = bodyOffset + (match.index ?? 0);
    methods.push({
      name,
      raw: source.slice(offset, offset + match[0].length),
      offset
    });
  }
  return methods;
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs.set(match[1]!, match[2] ?? match[3] ?? "");
  }
  return attrs;
}

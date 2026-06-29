export type DubboXmlEntry = {
  kind: "service" | "reference";
  interfaceName: string;
  id?: string;
  group?: string;
  version?: string;
  raw: string;
  offset: number;
};

export function parseDubboXmlConfig(source: string): DubboXmlEntry[] {
  if (!/<(?:\w+:)?beans[\s\S]*\bdubbo\b/i.test(source) && !/<dubbo:(service|reference)\b/i.test(source)) {
    return [];
  }

  const entries: DubboXmlEntry[] = [];
  const tagPattern = /<dubbo:(service|reference)\b([^>]*)\/?>/gi;
  for (const match of source.matchAll(tagPattern)) {
    const kind = match[1] as "service" | "reference";
    const rawAttrs = match[2] ?? "";
    const attrs = parseAttributes(rawAttrs);
    const interfaceName = attrs.get("interface");
    if (!interfaceName) continue;
    entries.push({
      kind,
      interfaceName,
      id: attrs.get("id") ?? attrs.get("ref"),
      group: attrs.get("group"),
      version: attrs.get("version"),
      raw: match[0],
      offset: match.index ?? 0
    });
  }
  return entries;
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs.set(match[1]!, match[2] ?? match[3] ?? "");
  }
  return attrs;
}

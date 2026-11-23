export interface ParsedIp {
  version: 4 | 6;
  bytes: number[];
}

const parseV4 = (text: string): number[] | null => {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
};

const parseV6 = (text: string): number[] | null => {
  let rest = text.split("%")[0];
  if (rest.includes(".")) {
    const lastColon = rest.lastIndexOf(":");
    const v4 = parseV4(rest.slice(lastColon + 1));
    if (!v4) return null;
    rest = `${rest.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const group = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
    return groups.some(Number.isNaN) ? null : groups;
  };
  const head = group(halves[0]);
  const back = halves.length === 2 ? group(halves[1]) : [];
  if (!head || !back) return null;
  const known = head.length + back.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const words = [...head, ...Array(8 - known).fill(0), ...back];
  return words.flatMap((w) => [w >> 8, w & 0xff]);
};

export const parseIp = (text: string): ParsedIp | null => {
  const trimmed = text.trim();
  const v4 = parseV4(trimmed);
  if (v4) return { version: 4, bytes: v4 };
  if (!trimmed.includes(":")) return null;
  const v6 = parseV6(trimmed);
  if (!v6) return null;
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped ? { version: 4, bytes: v6.slice(12) } : { version: 6, bytes: v6 };
};

// "1.2.3.4", "1.2.3.4:80", "[2001:db8::1]:443", "2001:db8::1" -> the address.
export const stripPort = (text: string): string => {
  const trimmed = text.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  if (bracketed) return bracketed[1];
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(trimmed);
  return v4WithPort ? v4WithPort[1] : trimmed;
};

export interface IpRange {
  version: 4 | 6;
  bytes: number[];
  prefix: number;
}

const NAMED_RANGES: Record<string, string[]> = {
  loopback: ["127.0.0.0/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
};

export const parseRanges = (entries: string[]): IpRange[] =>
  entries.flatMap((entry) => {
    const named = NAMED_RANGES[entry.trim().toLowerCase()];
    if (named) return parseRanges(named);
    const [address, prefixText] = entry.trim().split("/");
    const ip = parseIp(address);
    const max = ip?.version === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? max : /^\d+$/.test(prefixText) ? Number(prefixText) : NaN;
    if (!ip || !(prefix >= 0 && prefix <= max)) {
      throw new Error(`trustProxy: "${entry}" is not an IP address, a CIDR range, or loopback/linklocal/uniquelocal`);
    }
    return [{ version: ip.version, bytes: ip.bytes, prefix }];
  });

export const inRanges = (ip: ParsedIp, ranges: IpRange[]): boolean =>
  ranges.some((range) => {
    if (range.version !== ip.version) return false;
    for (let bit = 0; bit < range.prefix; bit++) {
      const mask = 0x80 >> bit % 8;
      if ((ip.bytes[bit >> 3] & mask) !== (range.bytes[bit >> 3] & mask)) return false;
    }
    return true;
  });

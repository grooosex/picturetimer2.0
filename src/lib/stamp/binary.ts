export function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

export function ascii(bytes: Uint8Array, start: number, length: number): string {
  let text = "";
  const end = Math.min(bytes.length, start + length);
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

export function startsWith(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let c = index;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[index] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    c = CRC_TABLE[(c ^ bytes[index]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function zoneOffset(ms: number): string {
  const minutes = -new Date(ms).getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const p = (value: number) => String(value).padStart(2, "0");
  return `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

export function utcIso(ms: number): string {
  const date = new Date(ms);
  const p = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
}

export function xmpPacket(iso: string, offset: string): Uint8Array {
  const stamp = `${iso}${offset}`;
  const xml =
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/">` +
    `<xmp:CreateDate>${stamp}</xmp:CreateDate><xmp:ModifyDate>${stamp}</xmp:ModifyDate>` +
    `<exif:DateTimeOriginal>${stamp}</exif:DateTimeOriginal><photoshop:DateCreated>${stamp}</photoshop:DateCreated>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  return new TextEncoder().encode(xml);
}

export function exifClock(ms: number): { date: string; sub: string; iso: string } {
  const date = new Date(ms);
  const p = (value: number) => String(value).padStart(2, "0");
  const y = date.getFullYear();
  const m = p(date.getMonth() + 1);
  const d = p(date.getDate());
  const h = p(date.getHours());
  const min = p(date.getMinutes());
  const s = p(date.getSeconds());
  return {
    date: `${y}:${m}:${d} ${h}:${min}:${s}`,
    sub: p(date.getMilliseconds()).padStart(3, "0").slice(0, 3),
    iso: `${y}-${m}-${d}T${h}:${min}:${s}`,
  };
}

export function parseExifLocal(date: string, sub?: string): number | null {
  const match = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(date);
  if (!match) return null;
  const ms = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ).getTime();
  if (!Number.isFinite(ms)) return null;
  const digits = (sub ?? "").replace(/\D/g, "");
  const extra = digits ? Number(digits.padEnd(3, "0").slice(0, 3)) : 0;
  return ms + (Number.isFinite(extra) ? extra : 0);
}

const DATE_RE = /(\d{4})([-:])(\d{2})\2(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/g;

function clockOf(found: string, wall: string, exifWall: string): string {
  if (found[4] === ":") return exifWall;
  if (found[10] === "T") return wall;
  return `${wall.slice(0, 10)} ${wall.slice(11)}`;
}

export function scrubDates(data: Uint8Array, wall: string, exifWall: string): Uint8Array | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (!/(\d{4})([-:])(\d{2})\2(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.test(text)) return data;
  DATE_RE.lastIndex = 0;
  const next = text.replace(DATE_RE, (found) => clockOf(found, wall, exifWall));
  const encoded = new TextEncoder().encode(next);
  if (encoded.length !== data.length) return null;
  return encoded;
}

export function hasDate(data: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  return new RegExp(DATE_RE.source).test(text);
}

export function wrongDate(data: Uint8Array, wall: string, exifWall: string): string | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  const re = new RegExp(DATE_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const found = match[0];
    if (found !== clockOf(found, wall, exifWall)) return found;
  }
  return null;
}

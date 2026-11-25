import { parseExifLocal, viewOf } from "./binary.ts";

const TAG_ORIENTATION = 0x0112;
const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_ORIGINAL = 0x9003;
const TAG_DIGITIZED = 0x9004;
const TAG_OFFSET = 0x9010;
const TAG_OFFSET_ORIGINAL = 0x9011;
const TAG_OFFSET_DIGITIZED = 0x9012;
const TAG_SUB = 0x9290;
const TAG_SUB_ORIGINAL = 0x9291;
const TAG_SUB_DIGITIZED = 0x9292;

function asciiBytes(text: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let index = 0; index < text.length && index < size - 1; index += 1) {
    out[index] = text.charCodeAt(index);
  }
  return out;
}

export function buildTiff(date: string, sub: string, orientation?: number, offset = "+00:00"): Uint8Array {
  const includeOrientation = orientation != null && orientation >= 1 && orientation <= 8;
  const ifd0Tags = includeOrientation ? 3 : 2;
  const ifd0Size = 2 + ifd0Tags * 12 + 4;
  const dateBytes = asciiBytes(date, 20);
  const subBytes = asciiBytes(sub, 4);
  const offsetBytes = asciiBytes(offset, 8);
  const exifCount = 8;
  const exifSize = 2 + exifCount * 12 + 4;
  const dateAt = 8 + ifd0Size;
  const originalAt = dateAt + 20;
  const digitizedAt = originalAt + 20;
  const offsetAt = digitizedAt + 20;
  const exifAt = offsetAt + 8;
  const total = exifAt + exifSize;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out[0] = 0x49;
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);

  let cursor = 8;
  view.setUint16(cursor, ifd0Tags, true);
  cursor += 2;
  const writeEntry = (
    tag: number,
    type: number,
    count: number,
    value: number,
    inline?: Uint8Array,
  ) => {
    view.setUint16(cursor, tag, true);
    view.setUint16(cursor + 2, type, true);
    view.setUint32(cursor + 4, count, true);
    if (inline) out.set(inline.subarray(0, 4), cursor + 8);
    else view.setUint32(cursor + 8, value, true);
    cursor += 12;
  };
  if (includeOrientation) writeEntry(TAG_ORIENTATION, 3, 1, orientation!);
  writeEntry(TAG_DATETIME, 2, 20, dateAt);
  writeEntry(TAG_EXIF_IFD, 4, 1, exifAt);
  view.setUint32(cursor, 0, true);
  out.set(dateBytes, dateAt);
  out.set(dateBytes, originalAt);
  out.set(dateBytes, digitizedAt);
  out.set(offsetBytes, offsetAt);

  cursor = exifAt;
  view.setUint16(cursor, exifCount, true);
  cursor += 2;
  writeEntry(TAG_ORIGINAL, 2, 20, originalAt);
  writeEntry(TAG_DIGITIZED, 2, 20, digitizedAt);
  writeEntry(TAG_OFFSET, 2, 7, offsetAt);
  writeEntry(TAG_OFFSET_ORIGINAL, 2, 7, offsetAt);
  writeEntry(TAG_OFFSET_DIGITIZED, 2, 7, offsetAt);
  writeEntry(TAG_SUB, 2, 4, 0, subBytes);
  writeEntry(TAG_SUB_ORIGINAL, 2, 4, 0, subBytes);
  writeEntry(TAG_SUB_DIGITIZED, 2, 4, 0, subBytes);
  view.setUint32(cursor, 0, true);
  return out;
}

type IfdEntry = { tag: number; type: number; count: number; valueOffset: number; raw: number };

function readIfd(bytes: Uint8Array, offset: number, little: boolean): IfdEntry[] {
  const view = viewOf(bytes);
  if (offset < 0 || offset + 2 > bytes.length) return [];
  const count = view.getUint16(offset, little);
  const entries: IfdEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const cursor = offset + 2 + index * 12;
    if (cursor + 12 > bytes.length) break;
    const tag = view.getUint16(cursor, little);
    const type = view.getUint16(cursor + 2, little);
    const size = view.getUint32(cursor + 4, little);
    const raw = view.getUint32(cursor + 8, little);
    entries.push({ tag, type, count: size, valueOffset: cursor + 8, raw });
  }
  return entries;
}

function entryText(bytes: Uint8Array, entry: IfdEntry, little: boolean): string {
  const width = entry.type === 2 ? 1 : entry.type === 3 ? 2 : entry.type === 4 ? 4 : 1;
  const bytesNeeded = entry.count * width;
  let start = entry.valueOffset;
  if (bytesNeeded > 4) {
    const view = viewOf(bytes);
    start = little ? view.getUint32(entry.valueOffset, true) : view.getUint32(entry.valueOffset, false);
  }
  if (start < 0 || start + entry.count > bytes.length) return "";
  let text = "";
  for (let index = 0; index < entry.count; index += 1) {
    const code = bytes[start + index];
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
}

export function readTiffTime(bytes: Uint8Array): { ms: number; orientation?: number } | null {
  if (bytes.length < 8) return null;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!little && !big) return null;
  const view = viewOf(bytes);
  const ifd0At = view.getUint32(4, little);
  const ifd0 = readIfd(bytes, ifd0At, little);
  let orientation: number | undefined;
  let date = "";
  let sub = "";
  let exifAt = 0;
  for (const entry of ifd0) {
    if (entry.tag === TAG_ORIENTATION && entry.type === 3) {
      orientation = little ? view.getUint16(entry.valueOffset, true) : view.getUint16(entry.valueOffset, false);
    } else if (entry.tag === TAG_DATETIME) date = entryText(bytes, entry, little);
    else if (entry.tag === TAG_EXIF_IFD) exifAt = entry.raw;
  }
  if (exifAt) {
    const exif = readIfd(bytes, exifAt, little);
    let original = "";
    let digitized = "";
    let subOriginal = "";
    for (const entry of exif) {
      if (entry.tag === TAG_ORIGINAL) original = entryText(bytes, entry, little);
      else if (entry.tag === TAG_DIGITIZED) digitized = entryText(bytes, entry, little);
      else if (entry.tag === TAG_SUB_ORIGINAL) subOriginal = entryText(bytes, entry, little);
      else if (entry.tag === TAG_SUB && !sub) sub = entryText(bytes, entry, little);
    }
    const chosen = original || digitized || date;
    const ms = parseExifLocal(chosen, subOriginal || sub);
    if (ms != null) return { ms, orientation };
  }
  const ms = parseExifLocal(date, sub);
  if (ms == null) return orientation ? { ms: NaN, orientation } : null;
  return { ms, orientation };
}

export function readTiffOffset(bytes: Uint8Array): string | null {
  if (bytes.length < 8) return null;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!little && !big) return null;
  const view = viewOf(bytes);
  const ifd0 = readIfd(bytes, view.getUint32(4, little), little);
  const exifAt = ifd0.find((entry) => entry.tag === TAG_EXIF_IFD)?.raw ?? 0;
  if (!exifAt) return null;
  const offset = readIfd(bytes, exifAt, little).find((entry) => entry.tag === TAG_OFFSET_ORIGINAL);
  if (!offset) return null;
  const text = entryText(bytes, offset, little);
  return /^[+-]\d{2}:\d{2}$/.test(text) ? text : null;
}

export function readOrientation(bytes: Uint8Array): number | undefined {
  const found = readTiffTime(bytes);
  return found?.orientation;
}

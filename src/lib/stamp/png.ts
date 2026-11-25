import { concat, crc32, exifClock, hasDate, sameBytes, utcIso, viewOf, wrongDate, xmpPacket, zoneOffset } from "./binary.ts";
import { buildTiff, readTiffOffset, readTiffTime } from "./tiff.ts";

type Chunk = { type: string; data: Uint8Array; raw: Uint8Array };

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function encodeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function readPngChunks(bytes: Uint8Array): Chunk[] | null {
  if (bytes.length < 8) return null;
  for (let index = 0; index < 8; index += 1) if (bytes[index] !== SIGNATURE[index]) return null;
  const view = viewOf(bytes);
  const chunks: Chunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const end = offset + 12 + length;
    if (length < 0 || end > bytes.length) return null;
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length), raw: bytes.subarray(offset, end) });
    offset = end;
    if (type === "IEND") return offset === bytes.length ? chunks : chunks;
  }
  return null;
}

export function pngIdat(bytes: Uint8Array): Uint8Array | null {
  const chunks = readPngChunks(bytes);
  if (!chunks?.some((chunk) => chunk.type === "IDAT") || !chunks.some((chunk) => chunk.type === "IEND")) return null;
  return concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
}

function tIme(ms: number): Uint8Array {
  const date = new Date(ms);
  const data = new Uint8Array(7);
  const view = new DataView(data.buffer);
  view.setUint16(0, date.getUTCFullYear());
  data[2] = date.getUTCMonth() + 1;
  data[3] = date.getUTCDate();
  data[4] = date.getUTCHours();
  data[5] = date.getUTCMinutes();
  data[6] = date.getUTCSeconds();
  return data;
}

function xmpText(packet: Uint8Array): Uint8Array {
  const keyword = new TextEncoder().encode("XML:com.adobe.xmp");
  const head = new Uint8Array(keyword.length + 5);
  head.set(keyword, 0);
  const data = new Uint8Array(head.length + packet.length);
  data.set(head, 0);
  data.set(packet, head.length);
  return data;
}

function isXmp(data: Uint8Array): boolean {
  const end = data.indexOf(0);
  let text = "";
  const count = end < 0 ? Math.min(data.length, 32) : end;
  for (let index = 0; index < count; index += 1) text += String.fromCharCode(data[index]);
  return text === "XML:com.adobe.xmp";
}

function compressedText(type: string, data: Uint8Array): boolean {
  if (type === "zTXt") return true;
  if (type !== "iTXt") return false;
  const zero = data.indexOf(0);
  return zero < 0 || zero + 1 >= data.length || data[zero + 1] !== 0;
}

export function stampPng(bytes: Uint8Array, ms: number): Uint8Array {
  const chunks = readPngChunks(bytes);
  const before = pngIdat(bytes);
  if (!chunks || !before || !chunks.some((chunk) => chunk.type === "IHDR")) throw new Error("文件已损坏");
  const clock = exifClock(ms);
  const offset = zoneOffset(ms);
  const tiff = buildTiff(clock.date, clock.sub, undefined, offset);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let inserted = false;
  const timeChunks = [
    encodeChunk("tIME", tIme(ms)),
    encodeChunk("eXIf", tiff),
    encodeChunk("iTXt", xmpText(xmpPacket(clock.iso, offset))),
  ];
  for (const chunk of chunks) {
    if (chunk.type === "tIME" || chunk.type === "eXIf") continue;
    if (chunk.type === "iTXt" || chunk.type === "tEXt" || chunk.type === "zTXt") {
      if (compressedText(chunk.type, chunk.data) || hasDate(chunk.data) || isXmp(chunk.data)) continue;
      parts.push(chunk.raw);
      continue;
    }
    if (!inserted && (chunk.type === "IDAT" || chunk.type === "IEND")) {
      parts.push(...timeChunks);
      inserted = true;
    }
    parts.push(chunk.raw);
  }
  if (!inserted) throw new Error("文件已损坏");
  const out = concat(parts);
  const after = pngIdat(out);
  if (!after || !sameBytes(before, after)) throw new Error("画面校验失败");
  return out;
}

export function readPngTime(bytes: Uint8Array): number | null {
  const chunks = readPngChunks(bytes);
  if (!chunks) return null;
  for (const chunk of chunks) {
    if (chunk.type !== "eXIf") continue;
    const tiff = chunk.data[0] === 0x45 && chunk.data[1] === 0x78 ? chunk.data.subarray(6) : chunk.data;
    const found = readTiffTime(tiff);
    if (found && Number.isFinite(found.ms)) return found.ms;
  }
  for (const chunk of chunks) {
    if (chunk.type !== "tIME" || chunk.data.length < 7) continue;
    const view = viewOf(chunk.data);
    const ms = new Date(
      view.getUint16(0),
      chunk.data[2] - 1,
      chunk.data[3],
      chunk.data[4],
      chunk.data[5],
      chunk.data[6],
    ).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

export function pngTimeProblem(bytes: Uint8Array, ms: number): string | null {
  const clock = exifClock(ms);
  const found = readPngTime(bytes);
  if (found !== ms) return found == null ? "读不出拍摄时间" : `时间不对，写成了 ${exifClock(found).iso.replace("T", " ")}`;
  const chunks = readPngChunks(bytes);
  if (!chunks) return "读不出拍摄时间";
  let seenImage = false;
  let timeBefore = false;
  for (const chunk of chunks) {
    if (chunk.type === "IDAT") seenImage = true;
    if (chunk.type === "tIME" || chunk.type === "eXIf") {
      if (seenImage) return "时间还在画面后面";
      timeBefore = true;
    }
    if (chunk.type === "tIME" && chunk.data.length >= 7) {
      const view = viewOf(chunk.data);
      const wall = `${view.getUint16(0)}-${String(chunk.data[2]).padStart(2, "0")}-${String(chunk.data[3]).padStart(2, "0")}T${String(chunk.data[4]).padStart(2, "0")}:${String(chunk.data[5]).padStart(2, "0")}:${String(chunk.data[6]).padStart(2, "0")}`;
      if (wall !== utcIso(ms)) return `时间不对，写成了 ${wall.replace("T", " ")}`;
    }
    if (chunk.type === "eXIf") {
      const tiff = chunk.data[0] === 0x45 && chunk.data[1] === 0x78 ? chunk.data.subarray(6) : chunk.data;
      if (readTiffOffset(tiff) !== zoneOffset(ms)) return "没有时区，相册会改时间";
    }
    if (chunk.type !== "tEXt" && chunk.type !== "iTXt" && chunk.type !== "zTXt") continue;
    if (compressedText(chunk.type, chunk.data)) return "还有旧时间没去掉";
    const stale = wrongDate(chunk.data, clock.iso, clock.date);
    if (stale) return `还有旧时间 ${stale}`;
  }
  if (!timeBefore) return "时间没写在画面前面";
  return null;
}

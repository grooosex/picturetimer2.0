import { concat, exifClock, sameBytes, viewOf, wrongDate, xmpPacket, zoneOffset } from "./binary.ts";
import { buildTiff, readTiffOffset, readTiffTime } from "./tiff.ts";

type Chunk = { type: string; data: Uint8Array };

const EXIF_FLAG = 0x08;
const XMP_FLAG = 0x04;
const ALPHA_FLAG = 0x10;
const ANIM_FLAG = 0x02;

function readChunks(bytes: Uint8Array): Chunk[] | null {
  if (bytes.length < 12) return null;
  const four = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[8], bytes[9], bytes[10], bytes[11]);
  if (four !== "RIFFWEBP") return null;
  const view = viewOf(bytes);
  const chunks: Chunk[] = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > bytes.length) return null;
    chunks.push({ type, data: bytes.subarray(offset + 8, end) });
    offset = end + (size & 1);
  }
  return chunks;
}

function encode(chunks: Chunk[]): Uint8Array {
  let payload = 4;
  for (const chunk of chunks) payload += 8 + chunk.data.length + (chunk.data.length & 1);
  const out = new Uint8Array(8 + payload);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  viewOf(out).setUint32(4, payload, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  let offset = 12;
  for (const chunk of chunks) {
    for (let index = 0; index < 4; index += 1) out[offset + index] = chunk.type.charCodeAt(index);
    viewOf(out).setUint32(offset + 4, chunk.data.length, true);
    out.set(chunk.data, offset + 8);
    offset += 8 + chunk.data.length;
    if (chunk.data.length & 1) offset += 1;
  }
  return out;
}

function vp8Size(data: Uint8Array): { w: number; h: number } | null {
  if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return null;
  return { w: (data[6] | (data[7] << 8)) & 0x3fff, h: (data[8] | (data[9] << 8)) & 0x3fff };
}

function vp8lSize(data: Uint8Array): { w: number; h: number } | null {
  if (data.length < 5 || data[0] !== 0x2f) return null;
  const bits = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
  return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
}

function makeVp8x(width: number, height: number, flags: number): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = flags;
  const w = width - 1;
  const h = height - 1;
  data[4] = w & 255;
  data[5] = (w >> 8) & 255;
  data[6] = (w >> 16) & 255;
  data[7] = h & 255;
  data[8] = (h >> 8) & 255;
  data[9] = (h >> 16) & 255;
  return data;
}

export function webpImage(bytes: Uint8Array): Uint8Array | null {
  const chunks = readChunks(bytes);
  const image = chunks?.find((chunk) => chunk.type === "VP8 " || chunk.type === "VP8L");
  return image ? image.data : null;
}

export function webpProblem(bytes: Uint8Array): string | null {
  const chunks = readChunks(bytes);
  if (!chunks) return "文件已损坏";
  if (chunks.some((chunk) => chunk.type === "ANMF" || chunk.type === "ANIM")) return "动图，写不进拍摄时间";
  const vp8x = chunks.find((chunk) => chunk.type === "VP8X");
  if (vp8x && vp8x.data[0] & ANIM_FLAG) return "动图，写不进拍摄时间";
  const image = chunks.find((chunk) => chunk.type === "VP8 " || chunk.type === "VP8L");
  if (!image) return "文件已损坏";
  const size = image.type === "VP8 " ? vp8Size(image.data) : vp8lSize(image.data);
  if (!size && !vp8x) return "文件已损坏";
  return null;
}

export function stampWebp(bytes: Uint8Array, ms: number): Uint8Array {
  const problem = webpProblem(bytes);
  if (problem) throw new Error(problem);
  const chunks = readChunks(bytes)!;
  const before = webpImage(bytes)!;
  const clock = exifClock(ms);
  const offset = zoneOffset(ms);
  const exif: Chunk = { type: "EXIF", data: buildTiff(clock.date, clock.sub, undefined, offset) };
  const xmp: Chunk = { type: "XMP ", data: xmpPacket(clock.iso, offset) };
  const image = chunks.find((chunk) => chunk.type === "VP8 " || chunk.type === "VP8L")!;
  const size = image.type === "VP8 " ? vp8Size(image.data) : vp8lSize(image.data);
  const alpha = chunks.some((chunk) => chunk.type === "ALPH");
  const next: Chunk[] = [];
  let hasVp8x = false;
  for (const chunk of chunks) {
    if (chunk.type === "EXIF" || chunk.type === "XMP ") continue;
    if (chunk.type === "VP8X") {
      const data = new Uint8Array(chunk.data);
      data[0] |= EXIF_FLAG | XMP_FLAG;
      next.push({ type: "VP8X", data });
      hasVp8x = true;
      continue;
    }
    next.push(chunk);
  }
  if (!hasVp8x) {
    if (!size) throw new Error("文件已损坏");
    next.unshift({ type: "VP8X", data: makeVp8x(size.w, size.h, EXIF_FLAG | XMP_FLAG | (alpha ? ALPHA_FLAG : 0)) });
  }
  next.push(exif, xmp);
  const out = encode(next);
  const after = webpImage(out);
  if (!after || !sameBytes(before, after)) throw new Error("画面校验失败");
  return out;
}

export function readWebpTime(bytes: Uint8Array): number | null {
  const chunks = readChunks(bytes);
  const exif = chunks?.find((chunk) => chunk.type === "EXIF");
  if (!exif) return null;
  const tiff = exif.data[0] === 0x45 && exif.data[1] === 0x78 ? exif.data.subarray(6) : exif.data;
  const found = readTiffTime(tiff);
  return found && Number.isFinite(found.ms) ? found.ms : null;
}

export function webpTimeProblem(bytes: Uint8Array, ms: number): string | null {
  const found = readWebpTime(bytes);
  if (found !== ms) return found == null ? "读不出拍摄时间" : `时间不对，写成了 ${exifClock(found).iso.replace("T", " ")}`;
  const chunks = readChunks(bytes);
  const exif = chunks?.find((chunk) => chunk.type === "EXIF");
  const tiff = exif && exif.data[0] === 0x45 && exif.data[1] === 0x78 ? exif.data.subarray(6) : exif?.data;
  if (!tiff || readTiffOffset(tiff) !== zoneOffset(ms)) return "没有时区，相册会改时间";
  const xmp = chunks?.find((chunk) => chunk.type === "XMP ");
  if (!xmp) return "没有时区，相册会改时间";
  const clock = exifClock(ms);
  const stale = wrongDate(xmp.data, clock.iso, clock.date);
  return stale ? `还有旧时间 ${stale}` : null;
}

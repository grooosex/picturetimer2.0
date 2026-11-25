import { concat, exifClock, hasDate, sameBytes, startsWith, wrongDate, xmpPacket, zoneOffset } from "./binary.ts";
import { buildTiff, readOrientation, readTiffOffset, readTiffTime } from "./tiff.ts";

type Segment = { marker: number; payload: Uint8Array };

const EXIF_HEADER = "Exif\0\0";
const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";

export function splitJpeg(bytes: Uint8Array): { segments: Segment[]; tail: Uint8Array } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const segments: Segment[] = [];
  let index = 2;
  while (index + 1 < bytes.length) {
    if (bytes[index] !== 0xff) return null;
    while (index < bytes.length && bytes[index] === 0xff) index += 1;
    if (index >= bytes.length) return null;
    const markerStart = index - 1;
    const marker = bytes[index];
    index += 1;
    if (marker === 0xda) return { segments, tail: bytes.subarray(markerStart) };
    if (marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, payload: new Uint8Array() });
      continue;
    }
    if (index + 2 > bytes.length) return null;
    const length = (bytes[index] << 8) | bytes[index + 1];
    if (length < 2 || index + length > bytes.length) return null;
    segments.push({ marker, payload: bytes.subarray(index + 2, index + length) });
    index += length;
  }
  return null;
}

function isExif(segment: Segment): boolean {
  return segment.marker === 0xe1 && startsWith(segment.payload, EXIF_HEADER);
}

function encodeSegment(segment: Segment): Uint8Array {
  if (segment.payload.length === 0 && (segment.marker === 0x01 || (segment.marker >= 0xd0 && segment.marker <= 0xd7))) {
    return Uint8Array.of(0xff, segment.marker);
  }
  const length = segment.payload.length + 2;
  const head = Uint8Array.of(0xff, segment.marker, (length >> 8) & 0xff, length & 0xff);
  return concat([head, segment.payload]);
}

export function jpegImageTail(bytes: Uint8Array): Uint8Array | null {
  return splitJpeg(bytes)?.tail ?? null;
}

export function stampJpeg(bytes: Uint8Array, ms: number): Uint8Array {
  const split = splitJpeg(bytes);
  if (!split) throw new Error("文件已损坏");
  const clock = exifClock(ms);
  const offset = zoneOffset(ms);
  let orientation: number | undefined;
  for (const segment of split.segments) {
    if (!isExif(segment)) continue;
    orientation = readOrientation(segment.payload.subarray(6));
    break;
  }
  const tiff = buildTiff(clock.date, clock.sub, orientation, offset);
  const header = new Uint8Array(EXIF_HEADER.length);
  for (let index = 0; index < EXIF_HEADER.length; index += 1) header[index] = EXIF_HEADER.charCodeAt(index);
  const exif: Segment = { marker: 0xe1, payload: concat([header, tiff]) };
  const xmpHeader = new Uint8Array(XMP_HEADER.length);
  for (let index = 0; index < XMP_HEADER.length; index += 1) xmpHeader[index] = XMP_HEADER.charCodeAt(index);
  const xmp: Segment = { marker: 0xe1, payload: concat([xmpHeader, xmpPacket(clock.iso, offset)]) };
  const kept: Segment[] = [];
  for (const segment of split.segments) {
    if (isExif(segment)) continue;
    if (segment.marker === 0xe1 && startsWith(segment.payload, XMP_HEADER)) continue;
    if (segment.marker === 0xfe) {
      if (!hasDate(segment.payload)) kept.push(segment);
      continue;
    }
    kept.push(segment);
  }
  const app0 = kept.findIndex((segment) => segment.marker === 0xe0);
  kept.splice(app0 >= 0 ? app0 + 1 : 0, 0, exif, xmp);
  const out = concat([Uint8Array.of(0xff, 0xd8), ...kept.map(encodeSegment), split.tail]);
  const check = jpegImageTail(out);
  if (!check || !sameBytes(check, split.tail)) throw new Error("画面校验失败");
  return out;
}

export function readJpegTime(bytes: Uint8Array): number | null {
  const split = splitJpeg(bytes);
  if (!split) return null;
  for (const segment of split.segments) {
    if (!isExif(segment)) continue;
    const found = readTiffTime(segment.payload.subarray(6));
    if (found && Number.isFinite(found.ms)) return found.ms;
  }
  return null;
}

export function jpegTimeProblem(bytes: Uint8Array, ms: number): string | null {
  const clock = exifClock(ms);
  const found = readJpegTime(bytes);
  if (found !== ms) return found == null ? "读不出拍摄时间" : `时间不对，写成了 ${exifClock(found).iso.replace("T", " ")}`;
  const split = splitJpeg(bytes);
  if (!split) return "读不出拍摄时间";
  for (const segment of split.segments) {
    const xmp = segment.marker === 0xe1 && startsWith(segment.payload, XMP_HEADER);
    if (!xmp && segment.marker !== 0xfe) continue;
    const stale = wrongDate(segment.payload, clock.iso, clock.date);
    if (stale) return `还有旧时间 ${stale}`;
  }
  const exif = split.segments.find(isExif);
  const zone = exif ? readTiffOffset(exif.payload.subarray(6)) : null;
  if (zone !== zoneOffset(ms)) return "没有时区，相册会改时间";
  return null;
}

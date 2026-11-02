import { AppError } from "./errors";

export const MAX_CLIP_BYTES = 50_000_000;
export function safeFilename(value: string): string {
  return (
    value
      .split(/[\\/]/)
      .pop()!
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .slice(0, 160) || "media"
  );
}
function atoms(
  bytes: Buffer,
  from = 0,
  to = bytes.length,
): Array<{ type: string; start: number; end: number; data: number }> {
  const result = [];
  let position = from;
  while (position + 8 <= to) {
    let size = bytes.readUInt32BE(position);
    let header = 8;
    if (size === 1) {
      if (position + 16 > to) break;
      const large = bytes.readBigUInt64BE(position + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
      header = 16;
    }
    if (size === 0) size = to - position;
    if (size < header || position + size > to) break;
    result.push({
      type: bytes.toString("ascii", position + 4, position + 8),
      start: position,
      end: position + size,
      data: position + header,
    });
    position += size;
  }
  return result;
}
export function validateMedia(
  bytes: Buffer,
  declaredMime: string,
): { mime: string; kind: "image" | "video"; extension: string } {
  if (bytes.length === 0 || bytes.length > MAX_CLIP_BYTES)
    throw new AppError(
      "FILE_SIZE",
      "Choose a nonempty file smaller than 50 MB.",
      422,
    );
  if (
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  ) {
    const w = bytes.readUInt32BE(16),
      h = bytes.readUInt32BE(20);
    if (!w || !h || w > 12_000 || h > 12_000 || w * h > 50_000_000)
      throw new AppError(
        "IMAGE_DIMENSIONS",
        "Choose an image with supported dimensions.",
        422,
      );
    let offset = 8,
      hasData = false,
      hasEnd = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset),
        type = bytes.toString("ascii", offset + 4, offset + 8);
      if (length > bytes.length - offset - 12) break;
      if (type === "IDAT" && length > 0) hasData = true;
      offset += length + 12;
      if (type === "IEND" && length === 0) {
        hasEnd = true;
        break;
      }
    }
    if (!hasData || !hasEnd || offset !== bytes.length)
      throw new AppError(
        "INVALID_IMAGE",
        "This PNG is incomplete or has invalid image chunks.",
        422,
      );
    if (declaredMime && declaredMime !== "image/png")
      throw new AppError(
        "MEDIA_MISMATCH",
        "The file content does not match its declared media type.",
        422,
      );
    return { mime: "image/png", kind: "image", extension: ".png" };
  }
  if (
    bytes.length >= 10 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  ) {
    let found = false;
    let position = 2;
    while (position + 4 < bytes.length) {
      if (bytes[position] !== 255) break;
      const marker = bytes[position + 1];
      position += 2;
      if (marker === 216 || marker === 217) continue;
      if (marker === 218) break;
      const size = bytes.readUInt16BE(position);
      if (size < 2 || position + size > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        size >= 7
      ) {
        const h = bytes.readUInt16BE(position + 3),
          w = bytes.readUInt16BE(position + 5);
        if (w && h && w <= 12_000 && h <= 12_000 && w * h <= 50_000_000)
          found = true;
        break;
      }
      position += size;
    }
    if (!found)
      throw new AppError(
        "INVALID_IMAGE",
        "This JPEG does not contain supported image dimensions.",
        422,
      );
    if (declaredMime && !["image/jpeg", "image/jpg"].includes(declaredMime))
      throw new AppError(
        "MEDIA_MISMATCH",
        "The file content does not match its declared media type.",
        422,
      );
    return { mime: "image/jpeg", kind: "image", extension: ".jpg" };
  }
  const top = atoms(bytes);
  const ftyp = top.find((a) => a.type === "ftyp");
  const moov = top.find((a) => a.type === "moov");
  if (ftyp && moov && top.some((a) => a.type === "mdat" && a.end > a.data)) {
    const brands = bytes.toString("ascii", ftyp.data, ftyp.end);
    if (
      ![
        "isom",
        "iso2",
        "iso6",
        "mp41",
        "mp42",
        "avc1",
        "M4V ",
        "dash",
        "MSNV",
      ].some((brand) => brands.includes(brand))
    )
      throw new AppError(
        "INVALID_VIDEO",
        "Use a standard MP4 container with a supported video codec.",
        422,
      );
    const videoTrack = atoms(bytes, moov.data, moov.end)
      .filter((a) => a.type === "trak")
      .some((track) => {
        const media = atoms(bytes, track.data, track.end).find(
          (a) => a.type === "mdia",
        );
        if (!media) return false;
        const mediaAtoms = atoms(bytes, media.data, media.end);
        const handler = mediaAtoms.find((a) => a.type === "hdlr");
        if (
          !handler ||
          handler.data + 12 > handler.end ||
          bytes.toString("ascii", handler.data + 8, handler.data + 12) !==
            "vide"
        )
          return false;
        const minf = mediaAtoms.find((a) => a.type === "minf");
        if (!minf) return false;
        const stbl = atoms(bytes, minf.data, minf.end).find(
          (a) => a.type === "stbl",
        );
        if (!stbl) return false;
        const table = atoms(bytes, stbl.data, stbl.end);
        const stsd = table.find((a) => a.type === "stsd");
        return Boolean(
          stsd &&
          stsd.data + 16 <= stsd.end &&
          ["avc1", "avc3", "hvc1", "hev1", "mp4v"].includes(
            bytes.toString("ascii", stsd.data + 12, stsd.data + 16),
          ),
        );
      });
    if (!videoTrack)
      throw new AppError(
        "INVALID_VIDEO",
        "This MP4 does not contain a supported video track. Use H.264 MP4.",
        422,
      );
    const mvhd = atoms(bytes, moov.data, moov.end).find(
      (a) => a.type === "mvhd",
    );
    if (!mvhd)
      throw new AppError(
        "INVALID_VIDEO",
        "This MP4 is missing its duration metadata.",
        422,
      );
    const version = bytes[mvhd.data];
    const scaleOffset = mvhd.data + (version === 1 ? 20 : 12);
    const durationOffset = scaleOffset + 4;
    if (durationOffset + (version === 1 ? 8 : 4) > mvhd.end)
      throw new AppError(
        "INVALID_VIDEO",
        "This MP4 has invalid metadata.",
        422,
      );
    const scale = bytes.readUInt32BE(scaleOffset);
    const duration =
      version === 1
        ? Number(bytes.readBigUInt64BE(durationOffset))
        : bytes.readUInt32BE(durationOffset);
    if (!scale || !duration || duration / scale > 60.5)
      throw new AppError(
        "VIDEO_DURATION",
        "Choose an MP4 clip lasting 60 seconds or less.",
        422,
      );
    if (declaredMime && declaredMime !== "video/mp4")
      throw new AppError(
        "MEDIA_MISMATCH",
        "The file content does not match its declared media type.",
        422,
      );
    return { mime: "video/mp4", kind: "video", extension: ".mp4" };
  }
  throw new AppError(
    "UNSUPPORTED_MEDIA",
    "Upload a valid JPEG, PNG or MP4 file. WebM recordings are not supported.",
    422,
  );
}
export async function boundedBytes(
  request: Request,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes)
    throw new AppError(
      "FILE_SIZE",
      "This request exceeds the supported upload size.",
      413,
    );
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError(
        "FILE_SIZE",
        "This request exceeds the supported upload size.",
        413,
      );
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

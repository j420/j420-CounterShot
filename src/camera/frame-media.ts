import { fail } from '../server/http';
import type { MediaFormat } from '../server/media';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const animationChunks = new Set(['acTL', 'fcTL', 'fdAT']);
const maxCameraSide = 1600;

/** A saved assessment and its regions must refer to one immutable still image. */
export function assertCameraStill(bytes: Buffer, format: MediaFormat): void {
  if (format.kind !== 'image') fail(415, 'Camera checks require one still JPEG or PNG frame.');
  if (format.container === 'jpeg') return;
  if (format.container !== 'png' || !bytes.subarray(0, 8).equals(pngSignature))
    fail(415, 'Camera checks require one still JPEG or PNG frame.');

  // Inspect actual chunk types, not byte substrings: a static PNG text chunk
  // can legitimately contain words such as "acTL". Pixel/CRC validation still
  // belongs to the existing complete image decoder after this structural gate.
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) fail(415, 'Choose a complete still PNG checkpoint.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) fail(415, 'Choose a complete still PNG checkpoint.');
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (width < 1 || height < 1 || width > maxCameraSide || height > maxCameraSide)
        fail(415, 'Use a camera frame no larger than 1600 pixels on either side.');
    } else if (type === 'IHDR') fail(415, 'Choose one complete still PNG checkpoint.');
    if (animationChunks.has(type))
      fail(415, 'Animated PNG is not a still camera checkpoint. Capture or choose a single JPEG/PNG frame.');
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) fail(415, 'Choose one complete still PNG checkpoint.');
      return;
    }
    offset = end;
  }
  fail(415, 'Choose a complete still PNG checkpoint.');
}

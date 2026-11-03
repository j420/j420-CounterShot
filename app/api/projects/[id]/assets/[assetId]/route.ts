import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { authorize, fail, route } from '../../../../../../src/server/http';
import { assetRoot, get } from '../../../../../../src/storage/db';
import type { Asset } from '../../../../../../src/server/types';

function attachmentName(name: string) {
  return encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

export const GET = route(async (req, ctx) => {
  const { id, assetId } = await ctx.params;
  authorize(req, id);
  const asset = get<Asset>('assets', assetId);
  if (!asset || asset.projectId !== id) fail(404, 'Asset not found.');
  const originalRequested = req.nextUrl.searchParams.get('original') === '1';
  const selected = originalRequested && asset.original ? asset.original : asset;
  const filePath = path.join(assetRoot, selected.storageKey);
  const size = (await stat(filePath)).size;
  const etag = `"${selected.sha256}"`;
  const headers: Record<string, string> = { 'Content-Type': selected.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox", ETag: etag, 'X-CounterShot-SHA256': selected.sha256 };
  if (originalRequested) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${attachmentName(selected.name)}`;
  const ifRange = req.headers.get('if-range');
  const range = ifRange && ifRange !== etag ? null : req.headers.get('range');
  let start = 0, end = size - 1;
  if (range !== null) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let valid = !!match && !!(match[1] || match[2]) && size > 0;
    if (match && valid) {
      if (!match[1]) {
        const suffix = Number(match[2]);
        valid = Number.isSafeInteger(suffix) && suffix > 0;
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start;
        end = Math.min(end, size - 1);
      }
    }
    if (!valid) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(Math.max(0, end - start + 1));
  if (size === 0) return new Response(null, { headers });
  const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status: range === null ? 200 : 206, headers });
});

import { NextRequest, NextResponse } from 'next/server';
import { ingestAsset } from '../../../../../src/server/asset-ingestion';
import { errorResponse, fail } from '../../../../../src/server/http';
import { configuredUploadOrigins, consumeUploadIntent } from '../../../../../src/server/upload-intents';

export const runtime = 'nodejs';
function allowedOrigin(req: NextRequest) {
  const origins = configuredUploadOrigins();
  if (!origins) fail(503, 'Direct media uploads are not configured on this server.');
  if (req.headers.get('origin') !== origins.appOrigin) fail(403, 'This upload origin is not permitted.');
  return origins.appOrigin;
}
function withCors(response: Response, origin?: string) {
  response.headers.set('Vary', 'Origin');
  response.headers.set('Cache-Control', 'private, no-store');
  if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
  return response;
}

// This endpoint has its own narrow capability check. Ordinary project routes retain
// their access-code and browser ownership checks; this token grants only one upload.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let origin: string | undefined;
  try {
    origin = allowedOrigin(req);
    const { id } = await ctx.params;
    const { project, purpose } = consumeUploadIntent(id, req.headers.get('authorization'));
    const asset = await ingestAsset(req, project, purpose);
    return withCors(NextResponse.json({ asset }, { status: 201 }), origin);
  } catch (error) {
    return withCors(errorResponse(error), origin);
  }
}

export async function OPTIONS(req: NextRequest) {
  let origin: string | undefined;
  try {
    origin = allowedOrigin(req);
    if (req.headers.get('access-control-request-method') !== 'POST') fail(403, 'This upload method is not permitted.');
    const requested = (req.headers.get('access-control-request-headers') || '').split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
    if (requested.some(header => !['authorization', 'content-type'].includes(header))) fail(403, 'These upload headers are not permitted.');
    const response = new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '300',
    } });
    return withCors(response, origin);
  } catch (error) {
    return withCors(errorResponse(error), origin);
  }
}

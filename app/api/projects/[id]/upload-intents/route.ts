import { NextResponse } from 'next/server';
import { authorize, jsonBody, route } from '../../../../../src/server/http';
import { createUploadIntent } from '../../../../../src/server/upload-intents';

export const runtime = 'nodejs';
export const POST = route(async (req, ctx) => {
  const { id } = await ctx.params;
  const project = authorize(req, id);
  return NextResponse.json({ upload: createUploadIntent(project, await jsonBody(req)) }, { headers: { 'Cache-Control': 'private, no-store' } });
});

import { NextResponse } from 'next/server';
import { submitCameraFrame, cameraResponseData } from '../../../../../../src/camera/server';
import { route } from '../../../../../../src/server/http';
export const runtime = 'nodejs';
export const maxDuration = 120;
export const POST = route(async (req, ctx) => {
  const startedAt = performance.now();
  const output = await submitCameraFrame(req, (await ctx.params).id);
  return NextResponse.json(cameraResponseData(output, startedAt), { status: output.pending ? 202 : 200, headers: { 'Cache-Control': 'private, no-store' } });
});

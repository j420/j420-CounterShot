import { NextResponse } from 'next/server';
import { cameraState, patchCameraSession, cameraResponseData } from '../../../../../src/camera/server';
import { jsonBody, route } from '../../../../../src/server/http';
export const runtime = 'nodejs';
export const GET = route(async (req, ctx) => {
  const startedAt = performance.now();
  return NextResponse.json(cameraResponseData(cameraState(req, (await ctx.params).id), startedAt), { headers: { 'Cache-Control': 'private, no-store' } });
});
export const PATCH = route(async (req, ctx) => {
  const startedAt = performance.now();
  return NextResponse.json(cameraResponseData(patchCameraSession(req, (await ctx.params).id, await jsonBody(req)), startedAt), { headers: { 'Cache-Control': 'private, no-store' } });
});

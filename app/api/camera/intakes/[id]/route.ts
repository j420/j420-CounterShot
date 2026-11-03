import { NextResponse } from 'next/server';
import { cameraIntakeState, cancelCameraIntake } from '../../../../../src/camera/intake';
import { jsonBody, route } from '../../../../../src/server/http';

export const runtime = 'nodejs';
export const GET = route(async (req, ctx) => NextResponse.json(cameraIntakeState(req, (await ctx.params).id),
  { headers: { 'Cache-Control': 'private, no-store' } }));
export const PATCH = route(async (req, ctx) => NextResponse.json(cancelCameraIntake(req, (await ctx.params).id, await jsonBody(req)),
  { headers: { 'Cache-Control': 'private, no-store' } }));

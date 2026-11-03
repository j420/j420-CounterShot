import { NextResponse } from 'next/server';
import { cameraIntakeByOperation, submitCameraIntake } from '../../../../src/camera/intake';
import { route } from '../../../../src/server/http';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const GET = route(req => NextResponse.json(cameraIntakeByOperation(req, req.nextUrl.searchParams.get('operationId') || ''),
  { headers: { 'Cache-Control': 'private, no-store' } }));
export const POST = route(async req => {
  const result = await submitCameraIntake(req, req.cookies.get('countershot_session')?.value || '');
  return NextResponse.json(result, { status: result.intake.status === 'pending' ? 202 : 200,
    headers: { 'Cache-Control': 'private, no-store' } });
});

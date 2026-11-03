import { NextResponse } from 'next/server';
import { cameraSessions, createOwnedCameraSession, cameraState, cameraResponseData } from '../../../../src/camera/server';
import { jsonBody, route, sessionFor, setSession } from '../../../../src/server/http';
import { NextRequest } from 'next/server';
export const runtime = 'nodejs';
export const GET = route(req => {
  const startedAt = performance.now();
  // Establish ownership before a paid intake POST, so a lost response can be recovered safely.
  const browser = sessionFor(req);
  return setSession(NextResponse.json(cameraResponseData(cameraSessions(req), startedAt), { headers: { 'Cache-Control': 'private, no-store' } }), req, browser);
});
export const POST = route(async req => {
  const startedAt = performance.now();
  const browser = sessionFor(req);
  const session = createOwnedCameraSession(await jsonBody(req), browser);
  // The newly generated browser cookie is not yet on the incoming request.
  const owned = new NextRequest(req.url, { headers: new Headers(req.headers) });
  owned.cookies.set('countershot_session', browser);
  return setSession(NextResponse.json(cameraResponseData(cameraState(owned, session.id), startedAt), { status: 201, headers: { 'Cache-Control': 'private, no-store' } }), req, browser);
});

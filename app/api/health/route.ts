import { NextResponse } from 'next/server';
import { metaStatus } from '../../../src/meta';
import { accessGranted, route } from '../../../src/server/http';
export const runtime='nodejs';
export const GET=route(req=>NextResponse.json({status:'ok',meta:metaStatus(),accessCodeRequired:!!process.env.APP_ACCESS_CODE,accessGranted:accessGranted(req),storage:'sqlite',physicalEnvelope:'Five bounded camera-guidance workflows plus a separate workshop-jig companion; actual physical outcomes require operator evidence.',cameraMode:'captured_frames_with_local_preview'}));

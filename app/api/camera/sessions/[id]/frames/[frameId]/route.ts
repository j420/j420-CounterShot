import { cameraFrameResponse } from '../../../../../../../src/camera/server';
import { route } from '../../../../../../../src/server/http';
export const runtime = 'nodejs';
export const GET = route(async (req, ctx) => {
  const { id, frameId } = await ctx.params;
  return cameraFrameResponse(req, id, frameId);
});

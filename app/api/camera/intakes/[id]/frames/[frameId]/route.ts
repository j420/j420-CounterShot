import { cameraIntakeFrameResponse } from '../../../../../../../src/camera/intake';
import { route } from '../../../../../../../src/server/http';

export const runtime = 'nodejs';
export const GET = route(async (req, ctx) => {
  const { id, frameId } = await ctx.params;
  return cameraIntakeFrameResponse(req, id, frameId);
});

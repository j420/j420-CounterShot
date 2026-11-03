import { NextResponse } from 'next/server';
import { authorize, route } from '../../../../../src/server/http';
import { ingestAsset } from '../../../../../src/server/asset-ingestion';
export const runtime = 'nodejs';
export const POST = route(async (req, ctx) => {
  const { id } = await ctx.params;
  const asset = await ingestAsset(req, authorize(req, id));
  return NextResponse.json({ asset }, { status: 201 });
});

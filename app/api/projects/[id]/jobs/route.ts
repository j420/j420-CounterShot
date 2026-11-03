import { NextResponse } from 'next/server';
import { authorize,jsonBody,route } from '../../../../../src/server/http';
import { enqueue } from '../../../../../src/jobs/queue';
export const POST=route(async(req,ctx)=>{const {id}=await ctx.params;return NextResponse.json({job:enqueue(authorize(req,id),await jsonBody(req))},{status:202});});

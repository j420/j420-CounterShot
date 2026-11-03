import { NextResponse } from 'next/server';
import { authorize,route } from '../../../../../../../src/server/http';
import { cancelJob } from '../../../../../../../src/jobs/queue';
export const POST=route(async(req,ctx)=>{const {id,jobId}=await ctx.params;authorize(req,id);return NextResponse.json({job:cancelJob(id,jobId)});});

import { NextResponse } from 'next/server';
import { authorize,jsonBody,route } from '../../../../../src/server/http';
import { confirmFacts } from '../../../../../src/server/projects';
export const POST=route(async(req,ctx)=>{const {id}=await ctx.params;const p=authorize(req,id);return NextResponse.json({snapshot:confirmFacts(p,await jsonBody(req))},{status:201});});

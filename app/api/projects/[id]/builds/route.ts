import { NextResponse } from 'next/server';
import { authorize,jsonBody,route } from '../../../../../src/server/http';
import { recordBuild } from '../../../../../src/server/projects';
export const POST=route(async(req,ctx)=>{const {id}=await ctx.params;return NextResponse.json({build:recordBuild(authorize(req,id),await jsonBody(req))},{status:201});});

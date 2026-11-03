import { NextResponse } from 'next/server';
import { authorize, publicProject, route } from '../../../../src/server/http';
import { list } from '../../../../src/storage/db';
import { jobsFor } from '../../../../src/jobs/queue';
import { metaStatus } from '../../../../src/meta';
export const runtime='nodejs';
export const GET=route(async(req,ctx)=>{const {id}=await ctx.params;const project=authorize(req,id);return NextResponse.json({project:publicProject(project),assets:list('assets',id),snapshots:list('snapshots',id),observations:list('observations',id),designs:list('designs',id),builds:list('builds',id),trials:list('trials',id),jobs:jobsFor(id),audit:list('audit',id),modelTraces:list('model_traces',id),modelAttemptTraces:list('model_attempt_traces',id),meta:metaStatus()});});

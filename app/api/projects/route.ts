import { NextResponse } from 'next/server';
import { createProject } from '../../../src/server/projects';
import { jsonBody, ownerHash, publicProject, route, sessionFor, setSession, fail } from '../../../src/server/http';
import { list } from '../../../src/storage/db';
import type { Project } from '../../../src/server/types';
export const runtime='nodejs';
export const GET=route(req=>{const owner=ownerHash(req);return NextResponse.json({projects:owner?list<Project>('projects').filter(p=>p.ownerHash===owner).map(publicProject):[]});});
export const POST=route(async req=>{const session=sessionFor(req);if(list<Project>('projects').filter(p=>p.ownerHash===ownerHash(req)).length>=30)fail(429,'This browser session has reached the 30-project prototype limit.');const project=createProject(await jsonBody(req),session);return setSession(NextResponse.json({project:publicProject(project)},{status:201}),req,session);});

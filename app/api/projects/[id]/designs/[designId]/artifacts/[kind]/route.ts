import { authorize,fail,route } from '../../../../../../../../src/server/http';
import { DOMAIN_SCHEMA_VERSION } from '../../../../../../../../src/domain/schema';
import { get } from '../../../../../../../../src/storage/db';
import type { Design,Snapshot } from '../../../../../../../../src/server/types';
export const GET=route(async(req,ctx)=>{
 const {id,designId,kind}=await ctx.params;const project=authorize(req,id);const design=get<Design>('designs',designId);if(!design||design.projectId!==id)fail(404,'Design not found.');
 const headers:Record<string,string>={'Cache-Control':'private, no-store','X-CounterShot-Revision':design.hash};
 if(kind==='evidence.json'){headers['Content-Type']='application/json';headers['Content-Disposition']=`attachment; filename="countershot-r${design.number}-manifest.json"`;return new Response(JSON.stringify({schemaVersion:DOMAIN_SCHEMA_VERSION,project:{id:project.id,title:project.title},design,inputSnapshot:get<Snapshot>('snapshots',design.inputSnapshotId),physicalStatus:'No physical success is implied by a geometry check.'},null,2),{headers});}
 if(!design.artifacts)fail(409,'No construction pack exists for this outcome or failed check.');
 const selected=(kind==='parts.svg'||kind==='package.svg')?design.artifacts.packageSvg:(kind==='setup.svg'||kind==='station.svg')?design.artifacts.stationSvg:kind==='print.html'?design.artifacts.printHtml:null;if(!selected)fail(404,'Artifact not found.');
 headers['Content-Type']=kind.endsWith('.svg')?'image/svg+xml; charset=utf-8':'text/html; charset=utf-8';headers['Content-Disposition']=`${kind==='print.html'?'inline':'attachment'}; filename="countershot-r${design.number}-${kind}"`;headers['Content-Security-Policy']="default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox allow-modals";
 return new Response(selected,{headers});
});

import { authorize,publicProject,route } from '../../../../../src/server/http';
import { list } from '../../../../../src/storage/db';
import { jobsFor } from '../../../../../src/jobs/queue';
import { DOMAIN_SCHEMA_VERSION } from '../../../../../src/domain/schema';
export const GET=route(async(req,ctx)=>{
  const {id}=await ctx.params;
  const project=authorize(req,id);
  const workshop=project.workflow==='workshop_jig';
  const output={
    schemaVersion:DOMAIN_SCHEMA_VERSION,exportedAt:new Date().toISOString(),project:publicProject(project),
    snapshots:list('snapshots',id),observations:list('observations',id),designs:list('designs',id),
    builds:list('builds',id),trials:list('trials',id),assets:list('assets',id),jobs:jobsFor(id),audit:list('audit',id),
    modelTraces:list('model_traces',id),modelAttemptTraces:list('model_attempt_traces',id),
    disclosure:{
      componentLibrary:workshop
        ?'Custom jig base, split exterior locating/bracing strips and a removable relieved front gate for one supplied low-force six-panel enclosure assembly family.'
        :'Historical measured carton/kit prototype: retaining tray or four-cell insert plus exterior supports.',
      workpieceOwnership:workshop?'Supplied product panels and joints remain fixed; the AI designs the jig and operating sequence.':'The original workpiece/packaging scope is preserved with this historical record.',
      physicalAdmission:'No fixture is physically admitted by software checks. The actual materials, joint topology, support transfers and complete operating cycle require trials.',
      reachModel:'Operator-confirmed planar rectangle from the front-left workspace origin; complete 3D motion and ergonomic benefit are unverified.',
      limitations:['No arbitrary CAD or powered-process support','No force/friction or structural-load validation','No certified alignment or safety rating','Synthetic examples contain no physical success evidence'],
      models:'Meta Muse Spark for observation, planning and trial-informed revision. SAM/image generation are not current dependencies.',
    },
  };
  return new Response(JSON.stringify(output,null,2),{headers:{'Content-Type':'application/json','Content-Disposition':`attachment; filename="countershot-${id}-evidence.json"`,'Cache-Control':'private, no-store'}});
});

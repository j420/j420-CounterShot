import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { bytesHash, get } from '../storage/db';
import type { Project } from './types';
import { uploadOrigins, UploadConfigError } from './upload-config';

export class HttpError extends Error{constructor(public status:number,message:string,public details?:unknown){super(message);}}
export function fail(status:number,message:string,details?:unknown):never{throw new HttpError(status,message,details);}
export function ownerHash(req:NextRequest){const s=req.cookies.get('countershot_session')?.value;return s?bytesHash(s):null;}
export function authorize(req:NextRequest,projectId:string){const project=get<Project>('projects',projectId);if(!project||!ownerHash(req)||project.ownerHash!==ownerHash(req))fail(404,'Project not found in this browser session.');return project;}
export function sessionFor(req:NextRequest){return req.cookies.get('countershot_session')?.value || randomBytes(32).toString('hex');}
export function setSession(response:NextResponse,req:NextRequest,session:string){response.cookies.set('countershot_session',session,{httpOnly:true,sameSite:'lax',secure:req.nextUrl.protocol==='https:',path:'/',maxAge:60*60*24*30});return response;}
export function publicProject(p:Project){const {ownerHash:_,...safe}=p;return {...safe,workflow:p.workflow||'carton_packing'};}
export function requireSameOrigin(req:NextRequest){
 const origin=req.headers.get('origin');
 let configured:ReturnType<typeof uploadOrigins>;
 try{configured=uploadOrigins();}catch(e){if(e instanceof UploadConfigError)fail(503,'Direct media uploads are not configured correctly.');throw e;}
 if(configured){
  if(!origin||origin===configured.appOrigin||origin===configured.apiOrigin)return;
  fail(403,'Cross-origin writes are not permitted.');
 }
 const host=req.headers.get('x-forwarded-host')||req.headers.get('host');
 if(origin){try{if(new URL(origin).host!==host)fail(403,'Cross-origin writes are not permitted.');}catch(e){if(e instanceof HttpError)throw e;fail(403,'Invalid request origin.');}}
}
export function accessGranted(req:NextRequest){const code=process.env.APP_ACCESS_CODE;if(!code)return true;const supplied=req.cookies.get('countershot_access')?.value;if(!supplied)return false;const a=Buffer.from(bytesHash(code)),b=Buffer.from(supplied);return a.length===b.length&&timingSafeEqual(a,b);}
export async function readBody(req:NextRequest,limitBytes:number):Promise<Uint8Array<ArrayBuffer>>{
  if(!Number.isSafeInteger(limitBytes)||limitBytes<0)throw new RangeError('Invalid request body limit.');
  const declaredLength=req.headers.get('content-length');
  if(declaredLength!==null){
    if(!/^\d+$/.test(declaredLength)||!Number.isSafeInteger(Number(declaredLength))){
      void req.body?.cancel().catch(()=>{});
      fail(400,'Invalid Content-Length header.');
    }
    if(Number(declaredLength)>limitBytes){
      void req.body?.cancel().catch(()=>{});
      fail(413,'Request too large.');
    }
  }
  if(!req.body)return new Uint8Array(0);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    reader=req.body.getReader();
    let bytes=new Uint8Array(Math.min(limitBytes,64*1024));
    let length=0;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      const nextLength=length+value.byteLength;
      if(nextLength>limitBytes){
        void reader.cancel().catch(()=>{});
        fail(413,'Request too large.');
      }
      if(nextLength>bytes.byteLength){
        const grown=new Uint8Array(Math.min(limitBytes,Math.max(nextLength,bytes.byteLength*2)));
        grown.set(bytes.subarray(0,length));
        bytes=grown;
      }
      bytes.set(value,length);
      length=nextLength;
    }
    return bytes.slice(0,length);
  }catch(e){
    if(e instanceof HttpError)throw e;
    void reader?.cancel().catch(()=>{});
    return fail(400,'The request body could not be read.');
  }finally{reader?.releaseLock();}
}
export async function jsonBody(req:NextRequest){const text=new TextDecoder().decode(await readBody(req,200_000));try{return JSON.parse(text);}catch{fail(400,'Expected a valid JSON request.');}}
export function errorResponse(e:unknown){if(e instanceof HttpError)return NextResponse.json({error:e.message,details:e.details},{status:e.status});if(e instanceof ZodError)return NextResponse.json({error:'Some inputs need attention.',details:e.issues},{status:400});console.error('[CounterShot]', e instanceof Error?e.message:'Unknown error');return NextResponse.json({error:'The operation could not be completed. Your saved work is preserved.'},{status:500});}
export function route(fn:(req:NextRequest,ctx:any)=>Promise<Response>|Response){return async(req:NextRequest,ctx:any)=>{try{if(req.method!=='GET')requireSameOrigin(req);if(!accessGranted(req)&&!['/api/health','/api/session'].includes(req.nextUrl.pathname))fail(401,'Enter the application access code to continue.');return await fn(req,ctx);}catch(e){return errorResponse(e);}};}

import { NextResponse } from 'next/server';
import { bytesHash } from '../../../src/storage/db';
import { fail, jsonBody, route } from '../../../src/server/http';
import { timingSafeEqual } from 'node:crypto';
export const POST=route(async req=>{const b=await jsonBody(req);const expected=process.env.APP_ACCESS_CODE;if(!expected)return NextResponse.json({ok:true});const a=Buffer.from(bytesHash(String(b.accessCode||''))),e=Buffer.from(bytesHash(expected));if(!timingSafeEqual(a,e))fail(401,'That access code is not correct.');const res=NextResponse.json({ok:true});res.cookies.set('countershot_access',bytesHash(expected),{httpOnly:true,sameSite:'lax',secure:req.nextUrl.protocol==='https:',path:'/',maxAge:86400});return res;});

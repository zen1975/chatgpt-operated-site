export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { executeCommand, trustedCommandRuntime } from '@/server/commands';
import { restToCanonicalCommand } from '@/server/adapters/rest';

async function hmac(secret:string, body:string, timestamp:string){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(sig)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

export const POST: APIRoute = async ({request}) => {
  const body=await request.text();
  const timestamp=request.headers.get('x-command-timestamp')||'';
  const signature=request.headers.get('x-command-signature')||'';
  if(!timestamp||!signature) return Response.json({success:false,error:{type:'FATAL_SYSTEM_ERROR',code:'AUTH_REQUIRED'}},{status:401});
  const expected=await hmac(env.COMMAND_HMAC_SECRET,body,timestamp);
  if(signature!==expected) return Response.json({success:false,error:{type:'FATAL_SYSTEM_ERROR',code:'AUTH_INVALID'}},{status:401});
  try {
    const command=restToCanonicalCommand(JSON.parse(body));
    return Response.json(await executeCommand(command, trustedCommandRuntime('authenticated-command-client')));
  } catch (error) {
    const e=error as any;
    return Response.json({success:false,error:{type:e.type||'USER_CORRECTABLE',code:e.code||'INVALID_COMMAND',message:e.message,retryable:Boolean(e.retryable),details:e.details||null}},{status:e.type==='FATAL_SYSTEM_ERROR'?500:400});
  }
};

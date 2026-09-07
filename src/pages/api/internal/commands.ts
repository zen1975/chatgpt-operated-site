import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { executeCommand, trustedCommandRuntime } from '@/server/commands';

const enc = new TextEncoder();
async function hmac(secret:string, body:string, timestamp:string) {
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',key,enc.encode(`${timestamp}.${body}`));
  return [...new Uint8Array(sig)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function safeEqual(a:string,b:string){ if(a.length!==b.length)return false; let x=0; for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i); return x===0; }

export const POST: APIRoute = async ({ request }) => {
  const timestamp=request.headers.get('x-command-timestamp')||'';
  const signature=request.headers.get('x-command-signature')||'';
  const age=Math.abs(Date.now()-Date.parse(timestamp));
  if (!timestamp || !Number.isFinite(age) || age > 5*60*1000) return Response.json({success:false,error:{code:'INVALID_TIMESTAMP'}},{status:401});
  const body=await request.text();
  const expected=await hmac(env.COMMAND_HMAC_SECRET,body,timestamp);
  if (!safeEqual(signature,expected)) return Response.json({success:false,error:{code:'INVALID_SIGNATURE'}},{status:401});
  try { return Response.json(await executeCommand(JSON.parse(body), trustedCommandRuntime('github-actions'))); }
  catch (e) { const message=e instanceof Error?e.message:String(e); const retryable=/timeout|429|5\d\d/i.test(message); return Response.json({success:false,error:{code:'COMMAND_FAILED',message,retryable}},{status:retryable?503:422}); }
};

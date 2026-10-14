import {readFileSync} from 'node:fs';
export async function run(argv, env=process.env, transport=fetch, stdin=()=>readFileSync(0,'utf8')) {
  const [action]=argv;
  if(argv.length!==1||!['context','create'].includes(action))throw Error('Use context or create with agent JSON on stdin');
  const base=new URL(env.NEST_MANAGEMENT_URL??'http://127.0.0.1:8789');
  if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(base.protocol==='https:'||(base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname))))throw Error('Management URL must be HTTPS or loopback HTTP');
  const token=env.NEST_MANAGEMENT_TOKEN;
  if(!/^nest_management\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token??''))throw Error('Authenticated Nest management is not enabled for this runtime');
  const body=action==='create'?JSON.parse(stdin()):undefined;
  const response=await transport(new URL(`/api/agent-management/${action==='create'?'agents':'context'}`,base),{
    method:action==='create'?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    redirect:'error',signal:AbortSignal.timeout(30_000),...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  if(!response.ok)throw Error(`Nest management returned ${response.status}. Creation may be unconfirmed; retry only the identical name and instructions, or report the denial.`);
  return response.json();
}
if(import.meta.url===new URL(process.argv[1]??'','file:').href)run(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error instanceof Error?error.message:'Nest management failed');process.exitCode=1;});

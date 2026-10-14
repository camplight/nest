import {readFileSync} from 'node:fs';
export async function run(argv, env=process.env, transport=fetch, stdin=()=>readFileSync(0,'utf8')) {
  const [action,name]=argv;
  if(!((argv.length===1&&['context','create'].includes(action))||(argv.length===2&&action==='get'&&name.trim()&&name.length<=80)))throw Error('Use context, get "Agent name", or create with agent JSON on stdin');
  const base=new URL(env.NEST_MANAGEMENT_URL??'http://127.0.0.1:8789');
  if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(base.protocol==='https:'||(base.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(base.hostname))))throw Error('Management URL must be HTTPS or loopback HTTP');
  const token=env.NEST_MANAGEMENT_TOKEN;
  if(!/^nest_management\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token??''))throw Error('Authenticated Nest management is not enabled for this runtime');
  const body=action==='create'?JSON.parse(stdin()):undefined;
  const path=action==='create'?'agents':action==='get'?`agents/${encodeURIComponent(name)}`:'context';
  const response=await transport(new URL(`/api/agent-management/${path}`,base),{
    method:action==='create'?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    redirect:'error',signal:AbortSignal.timeout(30_000),...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  if(!response.ok){
    const failure=await response.json().catch(()=>null);
    // Only print known Nest errors, never arbitrary upstream bodies or credentials.
    const reasons=new Map([
      ['That agent name already exists. Its settings were kept.','That agent name already exists; its settings were kept. Use get with the same name to check the requester’s existing agent.'],
      ['Agent creation is in progress. Retry the same request.','Agent creation is in progress. Retry the same request.'],
      ['Agent management context changed; retry','Agent management context changed; retry.'],
      ['No private agent with that name was found for this requester','No private agent with that name was found for this requester.'],
    ]);
    const reason=reasons.get(failure?.error)??(action==='create'?'Creation may be unconfirmed; retry only the identical name and instructions, or report the denial.':'The lookup was denied or unavailable.');
    throw Error(`Nest management returned ${response.status}. ${reason}`);
  }
  return response.json();
}
if(import.meta.url===new URL(process.argv[1]??'','file:').href)run(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error instanceof Error?error.message:'Nest management failed');process.exitCode=1;});

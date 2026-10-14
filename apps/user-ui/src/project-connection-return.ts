import type {Project} from '@nest/schemas';
const key='nest:connection-return';
export function rememberConnectionReturn(owner:string,project:string){try{sessionStorage.setItem(key,JSON.stringify({owner,project}));}catch{}}
export function consumeConnectionReturn(owner:string,projects:Project[],url:URL) {
  if(url.searchParams.get('status')!=='success'||!url.searchParams.has('connected_account_id')||['channel','project','share'].some(name=>url.searchParams.has(name)))return null;
  try{
    const saved=JSON.parse(sessionStorage.getItem(key)??'null');
    if(saved?.owner!==owner)return null;
    sessionStorage.removeItem(key);
    return projects.find(project=>project.id===saved.project)??null;
  }catch{return null;}
}

export function forgetConnectionReturn(owner:string){try{if(JSON.parse(sessionStorage.getItem(key)??'null')?.owner===owner)sessionStorage.removeItem(key);}catch{}}

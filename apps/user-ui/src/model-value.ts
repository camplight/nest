import type {OpenRouterModel,ModelBenchmarks} from '@nest/schemas';
export type ModelPoint={model:OpenRouterModel;cost:number;score:number;frontier:boolean};
export function modelPoints(models:OpenRouterModel[],benchmarks:ModelBenchmarks):ModelPoint[]{
  const scores=new Map(benchmarks.models.map(m=>[m.id,m.intelligence]));
  const points=models.flatMap(model=>{
    const score=scores.get(model.canonicalSlug??model.id)??scores.get(model.id);
    if(score===undefined||!Number.isFinite(score)||score<0||score>100||model.inputPrice===null||model.outputPrice===null||!Number.isFinite(model.inputPrice)||!Number.isFinite(model.outputPrice)||model.inputPrice<0||model.outputPrice<0)return [];
    return [{model,score,cost:(model.inputPrice+model.outputPrice)/2,frontier:false}];
  });
  return points.map(point=>({...point,frontier:!points.some(other=>other.cost<=point.cost&&other.score>=point.score&&(other.cost<point.cost||other.score>point.score))}));
}
export function representativePoints(points:ModelPoint[],selected:string,searching:boolean){
  if(searching)return points;
  const leaders=new Map<string,ModelPoint>();
  for(const point of points){const family=point.model.id.split('/')[0],previous=leaders.get(family);if(!previous||point.score>previous.score||(point.score===previous.score&&point.cost<previous.cost))leaders.set(family,point);}
  return points.filter(point=>point.frontier||point.model.id===selected||leaders.get(point.model.id.split('/')[0])===point);
}

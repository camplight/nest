import {it,expect} from 'vitest';
import {modelPoints,representativePoints} from './model-value';
import type {OpenRouterModel,ModelBenchmarks} from '@nest/schemas';
const model=(id:string,price:number|null):OpenRouterModel=>({id,name:id,inputPrice:price,outputPrice:price,description:'',context:1,tools:true,vision:false,reasoning:true});
const data:ModelBenchmarks={models:[{id:'a/cheap',intelligence:20},{id:'a/strong',intelligence:50},{id:'b/weak',intelligence:20},{id:'c/free',intelligence:10}],fetchedAt:1,asOf:null,stale:false};
it('finds true price/score dominance, retaining zero cost and excluding missing data',()=>{
 const points=modelPoints([model('a/cheap',1),model('a/strong',2),model('b/weak',3),model('c/free',0),model('d/unknown',null)],data);
 expect(points.filter(p=>p.frontier).map(p=>p.model.id)).toEqual(['a/cheap','a/strong','c/free']);
 expect(representativePoints(points,'b/weak',false).some(p=>p.model.id==='b/weak')).toBe(true);
});
it('keeps equal points and matches only exact canonical identities',()=>{
 const points=modelPoints([{...model('alias/name',1),canonicalSlug:'a/cheap'},model('a/cheap',1),model('a/cheap-v2',1)],data);
 expect(points).toHaveLength(2);expect(points.every(p=>p.frontier)).toBe(true);
});

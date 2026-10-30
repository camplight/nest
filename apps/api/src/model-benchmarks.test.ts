import {it,expect,vi} from 'vitest';
import {normalizeBenchmarks,createModelBenchmarks} from './model-benchmarks';
const row={source:'artificial-analysis',model_permaslug:'z-ai/glm-5.3',intelligence_index:50};
it('does not mix benchmark sources, missing scores, or ambiguous variants',()=>{
 expect(normalizeBenchmarks({data:[row,{...row,source:'openrouter',model_permaslug:'x/a'},{...row,intelligence_index:null,model_permaslug:'x/b'}]},1).models).toEqual([{id:'z-ai/glm-5.3',intelligence:50}]);
 expect(()=>normalizeBenchmarks({data:[row,{...row,intelligence_index:30}]},1)).toThrow();
});
it('coalesces per-key requests, limits retries, expires stale scores and sanitizes errors',async()=>{
 let now=1;const transport=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({data:[row]}));
 const get=createModelBenchmarks(transport,()=>now);
 await Promise.all([get('secret-a'),get('secret-a')]);expect(transport).toHaveBeenCalledTimes(1);
 await get('secret-b');expect(transport).toHaveBeenCalledTimes(2);
 now+=7*60*60_000;transport.mockRejectedValue(Error('secret-a provider details'));
 expect((await get('secret-a')).stale).toBe(true);expect((await get('secret-a')).stale).toBe(true);expect(transport).toHaveBeenCalledTimes(3);
 now+=25*60*60_000;await expect(get('secret-a')).rejects.toThrow('Benchmarks unavailable');
});

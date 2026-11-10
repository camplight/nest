// Synthetic file drops for the canvas browser suites. A module of its own: importing a scenario file would run its tests.
import type {Page} from 'playwright';

/** Dispatches a drag event carrying `names` as small text files at the first element matching `target`. */
export async function dragFiles(page:Page,target:string,names:string[],type:'drop'|'dragover'|'dragenter'|'dragleave'='drop'){
  const data=await page.evaluateHandle(names=>{const data=new DataTransfer();for(const name of names)data.items.add(new File(['synthetic bytes: '+name],name,{type:'text/plain'}));return data;},names);
  await page.locator(target).first().dispatchEvent(type,{dataTransfer:data});
  await data.dispose();
}
export const dropFile=(page:Page,target:string,name:string)=>dragFiles(page,target,[name]);

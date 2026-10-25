// Runs every tests/browser/chat-next/*.ts sequentially, one process each.
// Usage: npm run test:ui:chat-next [-- <file name filter>...]; a filter that matches nothing fails.
import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

const root=join(import.meta.dirname,'../../..'),dir=join(root,'tests/browser/chat-next');
const filters=process.argv.slice(2);
const all=existsSync(dir)?readdirSync(dir).filter(name=>name.endsWith('.ts')).sort():[];
const selected=filters.length?all.filter(name=>filters.some(filter=>name.includes(filter))):all;
if(!selected.length){
  if(filters.length){console.error(`No chat-next test matches ${filters.join(' ')}`);process.exit(1);}
  console.log('No chat-next tests yet (tests/browser/chat-next/ is empty).');process.exit(0);
}
const failed:string[]=[];
for(const name of selected){
  console.log(`\n=== chat-next ${name}`);
  const result=spawnSync(process.execPath,['--import','tsx',join(dir,name)],{cwd:root,stdio:'inherit'});
  if(result.status!==0)failed.push(name);
}
console.log(failed.length?`\nchat-next failed: ${failed.join(', ')}`:`\nchat-next passed: ${selected.length} file(s)`);
process.exit(failed.length?1:0);

// Test support for tailwind-scope.test.ts (spec 8.6); never imported by the app.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {compile} from '@tailwindcss/node';
import postcss from 'postcss';

export type SourceFile={path:string;text:string};
const chatDir=fileURLToPath(new URL('.',import.meta.url));

/** Class names of the utility rules chat.css generates for the given candidates. */
async function generatedClasses(candidates:string[]):Promise<Set<string>>{
  const css=(await compile(readFileSync(new URL('./chat.css',import.meta.url),'utf8'),{base:chatDir,onDependency(){}})).build(candidates);
  const names=new Set<string>();
  postcss.parse(css).walkAtRules('layer',layer=>{
    if(layer.params==='utilities')layer.walkRules(rule=>{
      for(const match of rule.selector.matchAll(/\.((?:\\.|[\w-])+)/g))names.add(match[1].replace(/\\(.)/g,'$1'));
    });
  });
  return names;
}

/** Class tokens a file sets in markup: class="…", className="…" and the string literals inside className={…}. */
function usedClasses(text:string):string[]{
  const tokens:string[]=[];
  const strings=(source:string)=>{for(const match of source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g))tokens.push(...match[2].replace(/\$\{[^}]*\}/g,' ').split(/\s+/));};
  for(const match of text.matchAll(/\bclass(?:Name)?\s*=\s*(?:(["'`])((?:\\.|(?!\1)[^\\])*)\1|\{)/g)){
    if(match[1]){tokens.push(...match[2].replace(/\$\{[^}]*\}/g,' ').split(/\s+/));continue;}
    let depth=1,end=match.index+match[0].length;
    while(end<text.length&&depth){const c=text[end++];if(c==='{')depth++;else if(c==='}')depth--;}
    strings(text.slice(match.index+match[0].length,end-1));
  }
  return tokens.filter(Boolean);
}

/** Generated chat utility class names that are also used as a class outside the chat. */
export async function classCollisions(chatCandidates:string[],outsideFiles:SourceFile[]):Promise<string[]>{
  const generated=await generatedClasses(chatCandidates);
  return [...new Set(outsideFiles.flatMap(file=>usedClasses(file.text)).filter(name=>generated.has(name)))].sort();
}

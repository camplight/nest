import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from '@tailwindcss/node';
import postcss,{type AtRule,type Container,type Rule} from 'postcss';
import {expect,it} from 'vitest';
import {classCollisions,type SourceFile} from './tailwind-scope-check';

const chatDir=fileURLToPath(new URL('.',import.meta.url));
const userSrc=join(chatDir,'..'),brandDir=join(chatDir,'../../../nest-brand');
const scopes=['.nest-chat','.nest-chat-composer','.nest-chat-portal'];
const sample=['border','shadow-sm','font-bold','ring-1','translate-y-1','animate-in','fade-in-0'];
// A missing chat.css compiles as an empty stylesheet, so every case fails by assertion.
const chatCss=()=>{try{return readFileSync(join(chatDir,'chat.css'),'utf8');}catch{return '';}};
const build=async(candidates:string[])=>(await compile(chatCss(),{base:chatDir,onDependency(){}})).build(candidates);
const files=(dir:string,keep:(path:string)=>boolean):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const path=join(dir,entry.name);return entry.isDirectory()?files(path,keep):keep(path)?[path]:[];
});
const read=(paths:string[]):SourceFile[]=>paths.map(path=>({path,text:readFileSync(path,'utf8')}));
const insideChat=(path:string)=>!relative(chatDir,path).startsWith('..');
const atRules=(root:Container,name:string)=>{const found:AtRule[]=[];root.walkAtRules(name,rule=>{found.push(rule);});return found;};
const unwrapDark=(selector:string)=>selector.replace(/:where\(\[data-theme=dark\], \[data-theme=dark\] \*\)/g,'');
const utilityClass=/^\.(?:\\.|[^\s.,#>+~:[\]()\\])+(?::{1,2}[\w-]+(?:\([^()]*\))?)*$/;

// Top-level output outside the chat scope: everything not in the spec 8.6 allow list.
function unscoped(css:string):string[]{
  const offenders:string[]=[];
  const visit=(container:Container)=>container.each(node=>{
    if(node.type==='atrule'){
      if(['layer','supports','media','container'].includes(node.name)){if(node.nodes)visit(node);return;}
      if(node.name==='property'&&node.params.startsWith('--tw-'))return;
      if(node.name==='keyframes')return;
      offenders.push(`@${node.name} ${node.params}`);return;
    }
    if(node.type!=='rule')return;
    const rule=node as Rule,selectors=rule.selectors.map(s=>s.trim());
    if(selectors.join(', ')===':root, :host')return;
    const decls=rule.nodes.filter(child=>child.type==='decl');
    if(decls.length&&rule.nodes.every(child=>child.type==='decl'&&child.prop.startsWith('--tw-')))return;
    if(selectors.every(s=>scopes.some(scope=>new RegExp(`\\${scope}(?![\\w-])`).test(s))))return;
    if(selectors.length===1&&utilityClass.test(unwrapDark(selectors[0])))return;
    offenders.push(rule.selector);
  });
  visit(postcss.parse(css));return offenders;
}

it('marks utilities important',async()=>{
  expect(await build(['flex'])).toContain('display: flex !important');
});

it('emits nothing unscoped except allowed output',async()=>{
  const css=await build(sample);
  for(const name of ['.border','.shadow-sm','.font-bold','.ring-1','.translate-y-1','.animate-in','.fade-in-0'])expect(css).toContain(name);
  expect(unscoped(css)).toEqual([]);
  expect(unscoped(css+'\nbutton { margin: 0 }')).toEqual(['button']);
});

it('maps theme colours to Nest tokens',async()=>{
  expect(await build(['bg-primary'])).toMatch(/\.bg-primary\s*\{[^}]*var\(--nest-forest\)/);
  expect(await build(['text-muted-foreground'])).toMatch(/\.text-muted-foreground\s*\{[^}]*var\(--nest-muted\)/);
});

it('binds dark mode to data-theme',async()=>{
  const css=await build(['dark:bg-card']),selectors:string[]=[];
  postcss.parse(css).walkRules(rule=>{selectors.push(rule.selector);});
  expect(selectors.some(s=>s.includes('dark\\:bg-card')&&s.includes('[data-theme=dark]'))).toBe(true);
  expect(css).not.toContain('prefers-color-scheme');
});

it('orders the motion layer before utilities',async()=>{
  const root=postcss.parse(await build(['flex','animate-in']));
  const order=atRules(root,'layer').find(rule=>!rule.nodes&&rule.params.includes('nest-chat-motion'));
  const layers=order?.params.split(',').map(name=>name.trim())??[];
  expect(layers).toContain('utilities');
  expect(layers.indexOf('nest-chat-motion')).toBeGreaterThanOrEqual(0);
  expect(layers.indexOf('nest-chat-motion')).toBeLessThan(layers.indexOf('utilities'));
  const motion=atRules(root,'layer').filter(rule=>rule.nodes&&rule.params==='nest-chat-motion');
  const reduced=motion.flatMap(layer=>atRules(layer,'media')).filter(media=>/prefers-reduced-motion:\s*reduce/.test(media.params));
  const rules:Rule[]=[];reduced.forEach(media=>media.walkRules(rule=>{rules.push(rule);}));
  const covering=rules.filter(rule=>scopes.every(scope=>rule.selector.includes(scope)));
  expect(covering.length).toBeGreaterThan(0);
  const decl=(rule:Rule,prop:string)=>rule.nodes.find(child=>child.type==='decl'&&child.prop===prop);
  expect(covering.some(rule=>['animation','transition'].every(prop=>{const d=decl(rule,prop);return d?.type==='decl'&&d.value==='none'&&d.important;}))).toBe(true);
  expect(covering.some(rule=>rule.selector.includes('*'))).toBe(true);
});

it('collides with no class used outside the chat',async()=>{
  expect(await classCollisions(['flex'],[{path:'fixture/outside.html',text:'<div class="flex">Synthetic fixture</div>'}])).toEqual(['flex']);
  const chatFiles=read(files(chatDir,path=>/\.(tsx?|css|md)$/.test(path)));
  const candidates=[...new Set(chatFiles.flatMap(file=>file.text.split(/[\s"'`]+/)).filter(Boolean))];
  const outside=read([...files(userSrc,path=>!insideChat(path)&&/\.(tsx?|jsx?|html)$/.test(path)),...files(brandDir,path=>/\.(tsx?|jsx?|html)$/.test(path)),join(userSrc,'../index.html')]);
  expect(outside.length).toBeGreaterThan(10);
  expect(await classCollisions(candidates,outside)).toEqual([]);
});

it('defines no theme variable Nest already uses',async()=>{
  const names:string[]=[];
  postcss.parse(await build([...sample,'flex','bg-primary','text-muted-foreground','dark:bg-card'])).walkRules(rule=>{
    if(rule.selector.replace(/\s+/g,' ')===':root, :host')rule.walkDecls(decl=>{if(decl.prop.startsWith('--'))names.push(decl.prop);});
  });
  const nestCss=[join(brandDir,'brand.css'),...files(userSrc,path=>!insideChat(path)&&path.endsWith('.css'))].map(path=>readFileSync(path,'utf8')).join('\n');
  expect(names.filter(name=>new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![\\w-])`).test(nestCss))).toEqual([]);
});

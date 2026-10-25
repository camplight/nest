import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';

// Spec 8.6 and D-12: every colour in the chat comes from the Nest token aliases in chat.css, never from a literal in
// a component. chat.css is not scanned; every chat .tsx file is, copied ui/ files included.
const chatDir=fileURLToPath(new URL('.',import.meta.url));
const files=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const path=join(dir,entry.name);return entry.isDirectory()?files(path):path.endsWith('.tsx')?[path]:[];
});

// CSS named colours plus Tailwind's palette names (a palette class such as bg-emerald-500 is a literal too).
const NAMED=('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood '+
 'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen '+
 'darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray '+
 'darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia '+
 'gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender '+
 'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink '+
 'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon '+
 'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise '+
 'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '+
 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red '+
 'rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow '+
 'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen '+
 'slate zinc neutral stone amber emerald sky rose mauve mist taupe').split(' ');
const named=new RegExp(`(?:^|[-[:\\s])(${NAMED.join('|')})(?=$|[-\\]/\\s;,!)])`,'gi');
const hex=/(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const fn=/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
// String, template and JSX attribute text: where class lists and style values live (comments are not scanned).
const strings=/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;

// Returns each colour literal found in the source's string literals, in order.
function colourLiterals(source:string):string[]{
  const code=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:'"`\\])\/\/.*$/gm,'$1');
  return (code.match(strings)??[]).flatMap(literal=>{
    const text=literal.slice(1,-1);
    return [...text.matchAll(hex),...text.matchAll(fn),...text.matchAll(named)].map(match=>(match[1]??match[0]).trim());
  });
}

describe('colourLiterals',()=>{
  it('finds hex, functional and named colours in class strings and styles',()=>{
    expect(colourLiterals(`<div className="bg-[#fff] p-2"/>`)).toEqual(['#fff']);
    expect(colourLiterals(`const s={color:'rgb(1 2 3)'};`)).toEqual(['rgb(']);
    expect(colourLiterals(`cn("text-white", 'border-red-500/40', "[color:hsl(0_0%_0%)]")`)).toEqual(['white','red','hsl(']);
    expect(colourLiterals(`<p style={{background:'black'}}/>`)).toEqual(['black']);
    expect(colourLiterals('`bg-emerald-500 ${x}`')).toEqual(['emerald']);
  });
  it('accepts theme tokens, ids and prose',()=>{
    expect(colourLiterals(`<a className="bg-muted text-muted-foreground ring-ring hover:bg-accent dark:bg-(--nest-accent)" href={\`#message-\${id}\`}>Load previous messages</a>`)).toEqual([]);
    expect(colourLiterals(`// a red comment with #fff\nconst x='No messages yet';`)).toEqual([]);
  });
});

it('no chat .tsx file holds a colour literal',()=>{
  const found=files(chatDir).map(path=>({file:relative(chatDir,path),literals:colourLiterals(readFileSync(path,'utf8'))})).filter(entry=>entry.literals.length>0);
  expect(found).toEqual([]);
});

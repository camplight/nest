export function run(argv:string[],env?:Record<string,string|undefined>,transport?:(url:URL,init:RequestInit)=>Promise<Response>,stdin?:()=>string):Promise<any>;

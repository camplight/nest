import {appendFileSync,chmodSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function configureLiveKit(directory,domain){
 const local=/^http:\/\/127\.0\.0\.1:\d+$/.test(domain);
 if(!local&&!/^[a-zA-Z0-9.-]+$/.test(domain))throw Error('Invalid LiveKit domain');
 const path=join(directory,'runtime.env'),env=parseEnv(readFileSync(path,'utf8'));
 const url=local?'ws://127.0.0.1:7880':`wss://${domain}:8443`;
 if(env.LIVEKIT_URL&&env.LIVEKIT_URL!==url)throw Error('Existing external LiveKit URL requires explicit operator migration');
 const key=env.LIVEKIT_API_KEY||`nest_${randomBytes(12).toString('hex')}`;
 const secret=env.LIVEKIT_API_SECRET||randomBytes(32).toString('hex');
 if(secret.length<32)throw Error('LiveKit API secret must contain at least 32 characters');
 const desired={LIVEKIT_URL:url,LIVEKIT_API_KEY:key,LIVEKIT_API_SECRET:secret,ORGOPS_VOICE_BROKER:'livekit',NEST_ENABLE_LIVEKIT:'1'};
 const additions=Object.entries(desired).filter(([k,v])=>env[k]!==v);
 if(additions.length)appendFileSync(path,'\n# Managed local LiveKit service\n'+additions.map(([k,v])=>`${k}='${v}'`).join('\n')+'\n');
 // JSON is valid YAML; structured serialization keeps secrets out of shell text.
 writeFileSync(join(directory,'livekit.yaml'),JSON.stringify({port:7880,bind_addresses:['127.0.0.1'],
  rtc:{tcp_port:7881,udp_port:7882,use_external_ip:!local},logging:{level:'info'},keys:{[key]:secret}},null,2)+'\n',{mode:0o640});
 mkdirSync(join(directory,'caddy.d'),{recursive:true,mode:0o755});
 chmodSync(join(directory,'caddy.d'),0o755);
 writeFileSync(join(directory,'caddy.d','livekit.caddy'),local?'':`https://${domain}:8443 {\n    reverse_proxy 127.0.0.1:7880\n}\n`,{mode:0o644});
 chmodSync(join(directory,'caddy.d','livekit.caddy'),0o644);
 writeFileSync(join(directory,'livekit-enabled'),'managed\n',{mode:0o600});
 return {url};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))configureLiveKit(process.argv[2],process.argv[3]);

// Synthetic long-thread regression: typing must not render every historical message.
import assert from 'node:assert/strict';
import {runChatTest} from '../support/chat-harness';

await runChatTest('composer: typing stays isolated from a long thread',async h=>{
  const {page}=h;
  // Install before React loads. Observe actual committed work rather than timing
  // thresholds, which vary with CI load. Count new thread props reaching a commit:
  // App creates these on each render, invalidating the thread context.
  // Raw browser JavaScript avoids tsx's function-name helpers in serialized callbacks.
  await page.addInitScript({content:`(() => {
    const counts={};
    const previousProps=new Map();
    const renderers=new Map();
    Object.defineProperty(navigator,'connection',{configurable:true,value:{downlink:10,effectiveType:'4g',saveData:false}});
    Object.assign(window,{
      __nestRenderCounts:counts,
      __REACT_DEVTOOLS_GLOBAL_HOOK__:{
        supportsFiber:true,renderers,
        inject:renderer=>{const id=renderers.size+1;renderers.set(id,renderer);return id;},
        onCommitFiberUnmount:()=>{},
        onCommitFiberRoot:(_id,root)=>{
          function visit(fiber){
            for(let node=fiber;node;node=node.sibling){
              const name=node.type?.name;
              if(name==='ChatThread'&&previousProps.get(name)!==node.memoizedProps){
                counts[name]=(counts[name]??0)+1;
                previousProps.set(name,node.memoizedProps);
              }
              visit(node.child);
            }
          }
          visit(root.current);
        },
      },
    });
  })();`});
  for(let i=0;i<60;i++)await h.emit('message.created',{text:`## Synthetic message ${i}\n\n**History** with a [link](https://example.test) and a list:\n\n- one\n- two\n\n\`\`\`js\nconst example = ${i};\n\`\`\``});
  await page.goto(`${h.base}/?channel=${h.project.channelId}`);
  const input=page.getByRole('textbox',{name:'Message',exact:true});
  await input.waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.nest-chat article.message').length>=50);
  await input.fill('');
  await page.waitForTimeout(500);
  const counts=()=>page.evaluate(()=>({...((window as unknown as {__nestRenderCounts:Record<string,number>}).__nestRenderCounts)}));
  const before=await counts();
  assert.ok(before.ChatThread>0,'render probe observes the real thread');
  const text='Typing in a long conversation remains responsive.';
  await input.pressSequentially(text);
  assert.equal(await input.inputValue(),text);
  const after=await counts();
  const threadRenders=(after.ChatThread??0)-(before.ChatThread??0);
  // Allow incidental server/poll updates, but not a history render per character.
  assert.ok(threadRenders<5,`typing ${text.length} characters rendered ChatThread ${threadRenders} times`);
  console.log(`Typing ${text.length} characters: ${threadRenders} thread renders`);
});

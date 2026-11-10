// Canvas browser suite: imports each scenario file in order. Each file runs its runChatTest
// calls against fresh servers; a failure sets process.exitCode and the next file still runs.
// Usage: npm run test:ui:canvas
export {};
const scenarios=['./entry.ts','./surface.ts','./cards.ts','./pile.ts','./open-chat.ts','./agents.ts','./sharing.ts','./find.ts','./devices.ts','./context.ts','./files-voice.ts','./apps.ts'];
for(const scenario of scenarios){
  console.log(`\n=== canvas ${scenario}`);
  await import(scenario);
}

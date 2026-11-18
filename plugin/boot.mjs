import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const name='ai-bridge-native';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.writeFileSync(path.join(root,'work','native-module-load.json'),JSON.stringify({at:Date.now(),root}));
export async function apply(ctx){
  return ctx.inject(['webServer'],async scoped=>{
    const mod=await import('./index.mjs?revision=20261013c');
    return await mod.apply(scoped);
  });
}

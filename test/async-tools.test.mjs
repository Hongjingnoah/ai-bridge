import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const require=createRequire(path.join(os.homedir(),'.dsh','profiles','desktop','package.json'));
const {Client}=require('@modelcontextprotocol/client');
const {StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
test('native catalog provides non-blocking start, result and cancel tools',async()=>{
  const client=new Client({name:'async-contract-test',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve(import.meta.dirname,'../bin/codex-bridge-mcp.mjs')]}));
    const tools=(await client.listTools()).tools.map(t=>t.name);
    for(const expected of ['codex_start','codex_result','codex_cancel'])assert.ok(tools.includes(expected),expected+' missing');
  }finally{await client.close();}
});

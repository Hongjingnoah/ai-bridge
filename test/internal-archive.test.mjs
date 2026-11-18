import {test} from 'node:test';
import assert from 'node:assert/strict';
import {askTurn} from '../lib/appserver.mjs';

function server({failure=false,archiveFailure=false}={}) {
  let notify;
  return {
    alive:true, calls:[], mark(){}, timelineReport(){return [];},
    onServerRequest(){}, onExit(){}, onNotification(fn){notify=fn;},
    async start(){}, stop(){this.alive=false;this.calls.push('stop');},
    async request(method,params){
      this.calls.push(method);
      if(method==='thread/start')return {thread:{id:'internal-test'}};
      if(method==='thread/resume')return {thread:{id:params.threadId}};
      if(method==='thread/archive'){
        assert.equal(params.threadId,'internal-test');
        if(archiveFailure)throw new Error('archive unavailable');
        return {};
      }
      if(method==='turn/start') {
        queueMicrotask(()=>{
          notify('item/completed',{item:{type:'agentMessage',phase:'final_answer',text:'internal result'}});
          notify('turn/completed',{turn:{id:'turn-test',status:failure?'failed':'completed'}});
        });
        return {turn:{id:'turn-test'}};
      }
      return {};
    }
  };
}

for (const resumed of [false,true]) test(`internal exchange archives before closing, resumed=${resumed}`,async()=>{
  const srv=server();
  const result=await askTurn({prompt:'internal task',threadId:resumed?'internal-test':undefined,serverFactory:()=>srv});
  assert.equal(result.text,'internal result');
  assert.ok(srv.calls.includes('thread/archive'));
  assert.ok(srv.calls.indexOf('thread/archive')<srv.calls.indexOf('stop'));
});

test('failed exchange still archives',async()=>{
  const srv=server({failure:true});
  await assert.rejects(askTurn({prompt:'internal task',serverFactory:()=>srv}),/turn failed/);
  assert.ok(srv.calls.includes('thread/archive'));
});

test('archive error preserves the answer and exposes the cleanup failure',async()=>{
  const srv=server({archiveFailure:true});
  const result=await askTurn({prompt:'internal task',serverFactory:()=>srv});
  assert.equal(result.text,'internal result');
  assert.equal(result.visibility.archived,false);
  assert.match(result.visibility.error,/archive unavailable/);
});

test('archived context is restored for continuation and archived again',async()=>{
  const srv=server();
  const request=srv.request.bind(srv);
  let archived=true;
  srv.request=async(method,params)=>{
    if(method==='thread/resume'&&archived)throw new Error('session internal-test is archived. Run codex unarchive');
    if(method==='thread/unarchive')archived=false;
    return request(method,params);
  };
  const result=await askTurn({prompt:'continue',threadId:'internal-test',serverFactory:()=>srv});
  assert.equal(result.text,'internal result');
  assert.ok(srv.calls.includes('thread/unarchive'));
  assert.equal(srv.calls.filter(x=>x==='thread/archive').length,1);
});

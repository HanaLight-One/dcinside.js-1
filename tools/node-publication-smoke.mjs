import test from 'node:test';
import assert from 'node:assert/strict';
import {DCInside, publicationDiagnostic} from '../dist/index.js';

globalThis.fetch=()=>{throw new Error('REAL_NETWORK_FORBIDDEN');};
function setup(reply) {
  let calls=0;
  const dc=new DCInside({session:{type:'login',id:'fixture',password:'secret-password',userId:'fixture-user'},
    http:{fetch:async(url,init)=>{calls++;assert.equal(String(url),'https://upload.dcinside.com/_app_write_api.php');assert.equal(init.redirect,'error');return reply(init);}}});
  dc.auth.ensureClientToken=async()=>'secret-client-token';
  dc.http.context={appId:async()=>'secret-app-id',refreshAppId:async()=>{throw new Error('REFRESH_FORBIDDEN');},relogin:async()=>{throw new Error('RELOGIN_FORBIDDEN');}};
  return {dc,calls:()=>calls};
}
const options=()=>({gallery:'chatgpt',subject:'fixture title',content:[{type:'image',file:new File(['abc'],'fixture.webp',{type:'image/webp'})},{type:'html',html:'<p>fixture body</p>'}]});
test('Node: records prepared and server rejection without sensitive values',async()=>{
  const h=setup(()=>new Response(JSON.stringify({result:false,cause:'잠시후 다시 이용해주세요.',token:'secret-response'})));
  const events=[];
  await assert.rejects(h.dc.articles.write({...options(),onDiagnostic:async e=>{events.push(e);}}),e=>publicationDiagnostic(e).reason==='try-later-unspecified');
  assert.equal(h.calls(),1);assert.equal(events.length,2);
  assert.deepEqual(events[0],{stage:'prepared',imageCount:1,imageBytes:3,blockCount:2,hasAppId:true,hasClientToken:true,hasUserId:true});
  assert.equal(events[1].result,'rejected');assert.equal(events[1].status,200);
  assert.ok(!/secret|fixture/.test(JSON.stringify(events)));
});
test('Node: failed prepared journal prevents request',async()=>{
  const h=setup(()=>new Response('{}'));
  await assert.rejects(h.dc.articles.write({...options(),onDiagnostic:async()=>{throw new Error('disk-full');}}),/disk-full/);
  assert.equal(h.calls(),0);
});
test('Node: failed response journal never causes resubmit',async()=>{
  const h=setup(()=>new Response('{"result":true}'));
  await assert.rejects(h.dc.articles.write({...options(),onDiagnostic:async e=>{if(e.stage==='response')throw new Error('disk-full');}}),/disk-full/);
  assert.equal(h.calls(),1);
});
test('Node: transport failure has no response and no retry',async()=>{
  const h=setup(()=>{throw new Error('secret-network-detail');});const events=[];
  await assert.rejects(h.dc.articles.write({...options(),onDiagnostic:async e=>{events.push(e);}}));
  assert.deepEqual(events.at(-1),{stage:'transport-error',responseReceived:false});assert.equal(h.calls(),1);
});
test('Node: 24 files survive actual multipart serialization',async()=>{
  const h=setup(async init=>{
    const r=new Request('https://example.invalid/',init);const f=await r.formData();
    for(let i=0;i<24;i++)assert.equal(await f.get(`upload[${i}]`).text(),`image-${i}`);
    return new Response('{"result":true}');
  });
  await h.dc.articles.write({...options(),content:Array.from({length:24},(_,i)=>({type:'image',file:new File([`image-${i}`],`${i}.png`,{type:'image/png'})}))});
  assert.equal(h.calls(),1);
});
test('Node: unknown server fields are not copied to diagnostics',async()=>{
  const h=setup(()=>new Response('{"result":false,"msg":"secret-password","refresh_join":false}'));const events=[];
  await assert.rejects(h.dc.articles.write({...options(),onDiagnostic:async e=>{events.push(e);}}));
  assert.equal(events[1].reason,'unspecified');assert.ok(!JSON.stringify(events).includes('secret'));
});

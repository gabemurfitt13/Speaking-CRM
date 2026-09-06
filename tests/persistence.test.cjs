const {test}=require('node:test');
const assert=require('node:assert/strict');
const {restore,rowFor,create}=require('../js/persistence.js');
test('full record round trip preserves custom school, contacts, verification and explicit blanks',()=>{
 const c={id:'custom',school:'New School',notes:'',email:'',extraContacts:[{name:'Adviser'}],contactConfidence:'VERIFIED',manualScore:8,lastVerified:'2026-09-06'};
 const result=restore([], [rowFor(c,'user')],{});
 assert.deepEqual(result[0].extraContacts,c.extraContacts);assert.equal(result[0].school,c.school);assert.equal(result[0].manualScore,8);
 assert.equal(restore([{id:'custom',email:'stale'}],[rowFor(c,'user')],{})[0].email,'');
});
test('legacy cloud rows preserve explicit cleared values and pending local changes win',()=>{
 assert.equal(restore([{id:'1',notes:'seed'}],[{school_id:'1',notes:''}],{})[0].notes,'');
 assert.equal(restore([{id:'1'}],[{school_id:'1',notes:'cloud'}],{'1':{id:'1',notes:'pending'}})[0].notes,'pending');
});
function harness(){
 const disk=new Map();let fail=false;const writes=[];
 const storage={getItem:k=>disk.get(k),setItem:(k,v)=>disk.set(k,v)};
 const client={from:()=>({select(){return this},eq(){return this},order(){return this},range:async()=>({data:[],error:null}),upsert:async rows=>{writes.push(rows);return {error:fail?{message:'offline'}:null}}})};
 return {disk,storage,client,writes,setFail:v=>fail=v};
}
test('email-only edits sync; failed writes retain pending changes and retry clears them',async()=>{
 const h=harness();const p=create(h.client,h.storage,'u',[{id:'1',status:'Not Started'}],()=>{});
 const contacts=await p.load();contacts[0].email='new@example.com';p.save(contacts);
 h.setFail(true);assert.equal(await p.flush(),false);assert.equal(p.hasPending(),true);
 h.setFail(false);assert.equal(await p.flush(),true);assert.equal(p.hasPending(),false);
 assert.equal(h.writes.at(-1)[0].record.email,'new@example.com');
});
test('pending changes survive reload and are isolated by account',async()=>{
 const h=harness();const p=create(h.client,h.storage,'one',[],()=>{});await p.load();p.save([{id:'new',school:'Local'}]);
 const reload=create(h.client,h.storage,'one',[],()=>{});assert.equal((await reload.load())[0].school,'Local');
 const other=create(h.client,h.storage,'two',[],()=>{});assert.deepEqual(await other.load(),[]);
});
test('empty flush does not prevent a later save',async()=>{
 const h=harness();const p=create(h.client,h.storage,'u',[],()=>{});await p.load();await p.flush();
 p.save([{id:'new'}]);assert.equal(await p.flush(),true);assert.equal(h.writes.length,1);
});
test('an edit during an in-flight save remains pending',async()=>{
 const h=harness();let release;h.client.from=()=>({select(){return this},eq(){return this},order(){return this},range:async()=>({data:[],error:null}),upsert:()=>new Promise(r=>{release=()=>r({error:null})})});
 const p=create(h.client,h.storage,'u',[],()=>{});await p.load();p.save([{id:'1',notes:'first'}]);const writing=p.flush();p.save([{id:'1',notes:'second'}]);release();await writing;assert.equal(p.hasPending(),true);
 const reloaded=create(h.client,h.storage,'u',[],()=>{});assert.equal((await reloaded.load())[0].notes,'second');
});
test('failed cloud load does not overwrite local pending work',async()=>{
 const h=harness();h.storage.setItem('gabe-crm-v4:u',JSON.stringify({pending:{'1':{id:'1',notes:'unsynced'}}}));
 h.client.from=()=>({select(){return this},eq(){return this},order(){return this},range:async()=>({error:new Error('denied')})});
 const p=create(h.client,h.storage,'u',[],()=>{});await assert.rejects(p.load(),/denied/);assert.equal(JSON.parse(h.storage.getItem('gabe-crm-v4:u')).pending['1'].notes,'unsynced');
});

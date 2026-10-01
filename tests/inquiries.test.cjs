const test=require('node:test');
const assert=require('node:assert/strict');
const {list,save}=require('../js/inquiries.js');
test('inquiry load is owner-scoped, paginated, and reports denied reads',async()=>{
  const scopes=[];let page=0;
  const client={from(t){assert.equal(t,'website_inquiries');return{select(){return this;},eq(k,v){scopes.push([k,v]);return this;},order(){return this;},range(){return Promise.resolve({data:page++===0?Array.from({length:500},(_,i)=>({id:i})): [{id:500}]});}};}};
  assert.equal((await list(client,'owner')).length,501);
  assert.deepEqual(scopes,[['user_id','owner'],['user_id','owner']]);
  const denied={from(){return{select(){return this;},eq(){return this;},order(){return this;},range(){return Promise.resolve({error:Error('denied')});}};}};
  await assert.rejects(list(denied,'owner'),/denied/);
});
test('inquiry saves only workflow fields, scopes owner/id, and requires a returned row',async()=>{
  let written;const scopes=[];
  const client={from(){return{update(v){written=v;return this;},eq(k,v){scopes.push([k,v]);return this;},select(){return this;},single(){return Promise.resolve({data:{id:'inquiry',...written}});}};}};
  const result=await save(client,'owner','inquiry',{status:'Booked',organization_type:'Organization',follow_up:'',booking_date:'2026-11-01',notes:'Agreed',email:'must-not-change',user_id:'other'});
  assert.equal(result.status,'Booked');assert.equal(written.follow_up,null);assert.equal(written.organization_type,undefined);assert.equal(written.email,undefined);assert.equal(written.user_id,undefined);
  assert.deepEqual(scopes,[['user_id','owner'],['id','inquiry']]);
  await assert.rejects(save(client,'owner','inquiry',{status:'wrong',organization_type:'School'}),/Invalid/);
  const denied={from(){return{update(){return this;},eq(){return this;},select(){return this;},single(){return Promise.resolve({error:Error('no row')});}};}};
  await assert.rejects(save(denied,'owner','inquiry',{status:'New',organization_type:'School'}),/no row/);
});

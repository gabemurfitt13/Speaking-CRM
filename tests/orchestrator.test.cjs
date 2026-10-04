const test=require('node:test'),assert=require('node:assert/strict');
global.CRMCommand={validDate:v=>/^\\d{4}-\\d{2}-\\d{2}$/.test(v||''),addDays:(s,n)=>{const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}};
const O=require('../js/orchestrator.js');
const base={kind:'progress',id:'1',key:'progress:1',test:false,closed:false,booked:false,command:{},raw:{},log:[],stage:'Contacted',followUp:'2026-10-01',payStatus:'Not Invoiced',date:'',location:'',audience:'',fee:null};
test('creates overdue follow-up recommendation',()=>{const a=O.proposals([base],{today:'2026-10-04'});assert.equal(a[0].action_type,'follow_up');assert.equal(a[0].priority,1);});
test('new inquiry gets immediate response recommendation',()=>{const r={...base,kind:'website_inquiries',key:'website_inquiries:2',raw:{status:'New'},followUp:''};assert.equal(O.proposals([r],{today:'2026-10-04'})[0].action_type,'respond_inquiry');});
test('closed records create no recommendations',()=>assert.equal(O.proposals([{...base,closed:true}],{today:'2026-10-04'}).length,0));
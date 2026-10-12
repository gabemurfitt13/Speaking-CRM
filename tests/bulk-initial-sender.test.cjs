const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/bulk-initial-sender/index.ts'),'utf8');
test('bulk worker only selects initial ready messages',()=>{
 assert.match(source,/\.eq\("kind","initial"\)\.eq\("status","ready"\)/);
 assert.doesNotMatch(source,/\.eq\("kind","follow_up"\)/);
});
test('worker requires server-side scheduler authentication',()=>{
 assert.match(source,/BULK_SENDER_CRON_SECRET/);
 assert.match(source,/GMAIL_REFRESH_TOKEN/);
 assert.match(source,/BULK_SENDER_FROM_EMAIL/);
});
test('worker holds ambiguous outcomes rather than auto-retrying',()=>{
 assert.match(source,/Ambiguous or failed send/);
 assert.match(source,/\.eq\("status","sending"\)/);
});
test('worker uses reviewed content rather than generated AI content',()=>{
 assert.match(source,/item\.approved_subject/);
 assert.match(source,/item\.approved_body/);
});

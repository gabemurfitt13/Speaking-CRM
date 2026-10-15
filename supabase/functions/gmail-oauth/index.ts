import {createClient} from 'npm:@supabase/supabase-js@2.95.0';
import {createHandler, googleCredentialEnv} from './handler.mjs';
const env = {...Object.fromEntries(['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY'].map(k => [k,Deno.env.get(k) || ''])), ...googleCredentialEnv(Deno.env.toObject())};
const db = createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const auth = createClient(env.SUPABASE_URL,env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const checked = ({data,error}) => {if(error) throw new Error('DATABASE_OPERATION_FAILED'); return data;};
const store = {
 async saveState(row) {
  checked(await db.from('gmail_oauth_states').delete().lt('expires_at',new Date().toISOString()));
  checked(await db.from('gmail_oauth_states').insert(row));
 },
 async consumeState(hash,now) {return checked(await db.from('gmail_oauth_states').delete().eq('state_hash',hash).gt('expires_at',now).select()).at(0) || null;},
 async saveConnection(row) {checked(await db.from('gmail_connections').upsert(row,{onConflict:'user_id'}));},
 async getConnection(id) {return checked(await db.from('gmail_connections').select('status,mailbox,connected_at').eq('user_id',id).maybeSingle());}
};
Deno.serve(createHandler({env,store,getUser:async token => {const {data,error}=await auth.auth.getUser(token); return error ? null : data.user;}}));

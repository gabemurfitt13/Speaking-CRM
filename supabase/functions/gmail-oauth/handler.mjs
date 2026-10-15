// OAuth connection only. This endpoint never sends mail.
export const OWNER = '344e07b9-d80c-4960-aa61-2732e73cbe59';
export const MAILBOX = 'gabemurfittspeaker@gmail.com';
export const ORIGIN = 'https://gabemurfitt13.github.io';
export const CLIENT_ID = '1049700318653-1obue381a9u2itjggddkhq6qq4g7ag9b.apps.googleusercontent.com';
export const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const encoder = new TextEncoder();
export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function digest(text) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}
async function encryptionKey(secret) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF', hash:'SHA-256', salt:encoder.encode('speaking-crm-gmail-v1'), info:encoder.encode(OWNER)}, material, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
}
export async function seal(text, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:encoder.encode(MAILBOX)}, await encryptionKey(secret), encoder.encode(text)));
  return {v:1, iv:base64url(iv), data:base64url(encrypted)};
}
export async function unseal(value, secret) {
  if (!value || value.v !== 1) throw new Error('CREDENTIAL_FORMAT');
  const decode = text => Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  const raw = await crypto.subtle.decrypt({name:'AES-GCM', iv:decode(value.iv), additionalData:encoder.encode(MAILBOX)}, await encryptionKey(secret), decode(value.data));
  return new TextDecoder().decode(raw);
}
export function createHandler(deps) {
  const {env, store, getUser, fetch: request = fetch, now = () => Date.now()} = deps;
  const configurationErrors = () => [!env.GOOGLE_CLIENT_ID ? 'GOOGLE_CLIENT_ID_MISSING' : env.GOOGLE_CLIENT_ID !== CLIENT_ID ? 'GOOGLE_CLIENT_ID_MISMATCH' : null, !env.GOOGLE_CLIENT_SECRET ? 'GOOGLE_CLIENT_SECRET_MISSING' : null, !env.SUPABASE_SERVICE_ROLE_KEY ? 'SERVER_KEY_MISSING' : null].filter(Boolean);
  const configured = () => configurationErrors().length === 0;
  const callback = env.SUPABASE_URL + '/functions/v1/gmail-oauth/callback';
  const headers = {'Content-Type':'application/json', 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'Access-Control-Allow-Origin':ORIGIN, 'Vary':'Origin', 'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods':'POST, OPTIONS'};
  const json = (body, status=200) => new Response(JSON.stringify(body), {status, headers});
  const page = (text, status=200) => new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Speaking CRM Gmail</title></head><body><main><h1>Speaking CRM Gmail</h1><p>'+text+'</p><a href="'+ORIGIN+'/Speaking-CRM/gmail-connect.html">Return to connection status</a></main></body></html>', {status, headers:{'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'none'; style-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options':'nosniff'}});
  return async req => {
    const url = new URL(req.url);
    const route = url.pathname.split('/').filter(Boolean).at(-1);
    if (req.method === 'OPTIONS') return req.headers.get('Origin') === ORIGIN ? new Response(null, {status:204, headers}) : json({error:'ORIGIN_NOT_ALLOWED'},403);
    if (req.method === 'GET' && route === 'health') return json({ok:true, configured:configured(), configurationErrors:configurationErrors(), sendsEmail:false});
    try {
      if (req.method === 'GET' && route === 'callback') {
        if (!configured()) return page('Google client credentials are not configured. No connection was saved.',503);
        const state = url.searchParams.get('state') || '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return page('Missing or invalid authorization state. Start again from the CRM connection page.',400);
        // Atomic DELETE ... RETURNING: expired states and replayed callbacks never exchange a code.
        const record = await store.consumeState(await digest(state), new Date(now()).toISOString());
        if (!record || record.user_id !== OWNER) return page('This authorization attempt expired or was already used. Start again from the CRM connection page.',400);
        if (url.searchParams.has('error')) return page('Google authorization was declined. No connection was changed.',400);
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096) return page('Google did not return a valid authorization code. Start again.',400);
        const verifier = await unseal(record.verifier_encrypted, env.SUPABASE_SERVICE_ROLE_KEY);
        const tokenResult = await request('https://oauth2.googleapis.com/token', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID, client_secret:env.GOOGLE_CLIENT_SECRET, code, code_verifier:verifier, grant_type:'authorization_code', redirect_uri:callback}), signal:AbortSignal.timeout(20000)});
        if (!tokenResult.ok) return page('Google rejected the authorization exchange. Check the client secret and redirect URI, then start again. No connection was changed.',502);
        const tokens = await tokenResult.json();
        const granted = (tokens.scope || '').split(' ');
        if (!tokens.access_token || !SCOPES.every(s => granted.includes(s))) return page('Both Gmail read and send permissions are required. No connection was saved.',400);
        const profileResult = await request('https://gmail.googleapis.com/gmail/v1/users/me/profile', {headers:{Authorization:'Bearer '+tokens.access_token}, signal:AbortSignal.timeout(20000)});
        if (!profileResult.ok) return page('Gmail could not verify the mailbox. No connection was saved. Start again after the Gmail API is enabled and available.',502);
        const profile = await profileResult.json();
        if ((profile.emailAddress || '').toLowerCase() !== MAILBOX) return page('The selected Google account is not the authorized speaking mailbox. No connection was saved. Start again and choose the speaking account.',403);
        if (!tokens.refresh_token) return page('Google did not issue offline access. No connection was changed. Start again and approve access.',400);
        await store.saveConnection({user_id:OWNER, mailbox:MAILBOX, refresh_token_encrypted:await seal(tokens.refresh_token, env.SUPABASE_SERVICE_ROLE_KEY), granted_scopes:granted, connected_at:new Date(now()).toISOString(), last_verified_at:new Date(now()).toISOString(), status:'connected'});
        return page('Gmail authorization was saved and the speaking mailbox was verified. This connection step did not send any emails. The sending worker still requires a verified deployment before background outreach can resume.');
      }
      if (req.method !== 'POST' || !['start','status'].includes(route)) return json({error:'NOT_FOUND'},404);
      if (req.headers.get('Origin') && req.headers.get('Origin') !== ORIGIN) return json({error:'ORIGIN_NOT_ALLOWED'},403);
      const bearer = req.headers.get('Authorization') || '';
      if (!bearer.startsWith('Bearer ')) return json({error:'SIGN_IN_REQUIRED'},401);
      const user = await getUser(bearer.slice(7));
      if (!user || user.id !== OWNER) return json({error:'OWNER_SIGN_IN_REQUIRED'},403);
      if (route === 'status') {
        const connection = await store.getConnection(OWNER);
        return json({configured:configured(), connected:connection?.status === 'connected', mailbox:connection?.mailbox || null, connectedAt:connection?.connected_at || null, sendsEmail:false});
      }
      if (!configured()) return json({error:'GOOGLE_CLIENT_SECRETS_MISSING_OR_CLIENT_ID_MISMATCH'},503);
      const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      await store.saveState({state_hash:await digest(state), user_id:OWNER, verifier_encrypted:await seal(verifier,env.SUPABASE_SERVICE_ROLE_KEY), expires_at:new Date(now()+600000).toISOString()});
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.search = new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID, redirect_uri:callback, response_type:'code', scope:SCOPES.join(' '), access_type:'offline', prompt:'consent', login_hint:MAILBOX, state, code_challenge:await digest(verifier), code_challenge_method:'S256'}).toString();
      return json({authorizationUrl:authUrl.toString()});
    } catch {
      // Never echo provider bodies, authorization codes, tokens, or request URLs.
      return json({error:'GMAIL_CONNECTION_FAILED', message:'No authorization success was confirmed. Check configuration and retry from the connection page.'},500);
    }
  };
}

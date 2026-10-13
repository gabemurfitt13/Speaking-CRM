// Edge Function: send-email
// Sends an outreach email via Resend, then logs it against the contact's row
// in either the `progress` table (schools) or the new `leads` table (business/church).
//
// Required secrets (set via `supabase secrets set NAME=value` or the Dashboard):
//   RESEND_API_KEY   - your Resend API key
//   FUNCTION_SECRET  - shared secret this function checks on every call
//   FROM_EMAIL       - the "from" address, e.g. speaking@gabemurfitt.com
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
const FUNCTION_SECRET = Deno.env.get('FUNCTION_SECRET')!
const FROM_EMAIL = Deno.env.get('FROM_EMAIL') || 'onboarding@resend.dev'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

Deno.serve(async (req) => {
  if (req.headers.get('x-function-secret') !== FUNCTION_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  let payload: {
    table?: string
    id?: string
    userId?: string
    to?: string
    subject?: string
    body?: string
    templateType?: string
  }

  try {
    payload = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 })
  }

  const { table, id, userId, to, subject, body, templateType } = payload

  if (!table || !id || !userId || !to || !subject || !body || !templateType) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: table, id, userId, to, subject, body, templateType' }),
      { status: 400 },
    )
  }
  if (table !== 'progress' && table !== 'leads') {
    return new Response(JSON.stringify({ error: "table must be 'progress' or 'leads'" }), { status: 400 })
  }

  if(table === 'progress' && /follow.?up/i.test(templateType)) return new Response(JSON.stringify({error:'GMAIL_THREAD_REQUIRED',message:'School follow-ups must use the verified original Gmail conversation. Resend follow-up sending is disabled.'}),{status:409});

  // 1. Send via Resend
  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to,
      subject,
      html: body.replace(/\n/g, '<br>'),
      text: body,
    }),
  })

  if (!resendRes.ok) {
    const errText = await resendRes.text()
    return new Response(JSON.stringify({ error: 'Resend send failed', detail: errText }), { status: 502 })
  }

  const resendData = await resendRes.json()

  // 2. Log it against the contact's row
  const idColumn = table === 'progress' ? 'school_id' : 'id'
  const now = new Date().toISOString().slice(0, 10)
  const followUpDate = new Date()
  followUpDate.setDate(followUpDate.getDate() + 7)
  const followUpStr = followUpDate.toISOString().slice(0, 10)

  const { data: existing, error: fetchError } = await supabase
    .from(table)
    .select('log, status')
    .eq(idColumn, id)
    .eq('user_id', userId)
    .maybeSingle()

  if (fetchError) {
    return new Response(JSON.stringify({ error: 'Lookup failed', detail: fetchError.message }), { status: 500 })
  }

  const newLogEntry = {
    date: now,
    type: templateType === 'initial' ? 'Emailed' : templateType === 'followup' ? 'Follow-up sent' : 'Email sent',
    subject,
    resendId: resendData.id,
  }

  if (existing) {
    const updatedLog = Array.isArray(existing.log) ? [...existing.log, newLogEntry] : [newLogEntry]
    const { error: updateError } = await supabase
      .from(table)
      .update({
        log: updatedLog,
        contacted: now,
        status: !existing.status || existing.status === 'Not Started' ? 'Emailed' : existing.status,
        ...(templateType === 'initial' ? { follow_up: followUpStr } : {}),
      })
      .eq(idColumn, id)
      .eq('user_id', userId)

    if (updateError) {
      return new Response(JSON.stringify({ error: 'DB update failed', detail: updateError.message }), { status: 500 })
    }
  } else {
    const { error: insertError } = await supabase
      .from(table)
      .insert({
        [idColumn]: id,
        user_id: userId,
        log: [newLogEntry],
        contacted: now,
        status: 'Emailed',
        ...(templateType === 'initial' ? { follow_up: followUpStr } : {}),
      })

    if (insertError) {
      return new Response(JSON.stringify({ error: 'DB insert failed', detail: insertError.message }), { status: 500 })
    }
  }

  return new Response(JSON.stringify({ success: true, resendId: resendData.id }), { status: 200 })
})


-- Activate only after tested Gmail sends and CRM synchronization. Upserts by unique job name.
select cron.schedule('speaking-crm-existing-gmail-worker','*/2 * * * *','select public.gmail_outreach_worker_tick();');

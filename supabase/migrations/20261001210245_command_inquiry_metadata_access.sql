-- Preserve the existing narrow inquiry update grants and owner RLS.
-- Allow owners to edit only the new opportunity metadata column.
grant update(command) on public.website_inquiries to authenticated;

-- Linux AR: profile creation, username availability, and least-privilege RLS.
-- The five public tables already created in this project are reused; no tables are recreated.

create or replace function public.is_username_available(p_username text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select p_username ~ '^[A-Za-z0-9_]{3,24}$'
     and not exists (
       select 1 from public.profiles p
       where lower(p.username) = lower(trim(p_username))
     );
$$;

revoke all on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated;

create or replace function public.linux_ar_create_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
begin
  v_username := trim(coalesce(new.raw_user_meta_data ->> 'username', ''));
  if v_username !~ '^[A-Za-z0-9_]{3,24}$' then
    raise exception 'A valid Linux AR username is required.';
  end if;
  insert into public.profiles (id, username)
  values (new.id, v_username)
  on conflict (id) do update set username = excluded.username;
  return new;
end;
$$;

drop trigger if exists linux_ar_profile_after_signup on auth.users;
create trigger linux_ar_profile_after_signup
after insert on auth.users
for each row execute procedure public.linux_ar_create_profile();

-- Replace existing policies on these five app tables with the intended policies.
-- Browser users can only read/update their own profile and progress. Telegram
-- linkage and quiz result writes are server-only through the Edge Function.
do $$
declare
  pol record;
begin
  for pol in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles','telegram_accounts','telegram_link_tokens','lesson_progress','quiz_results')
  loop
    execute format('drop policy if exists %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;

alter table public.profiles enable row level security;
alter table public.telegram_accounts enable row level security;
alter table public.telegram_link_tokens enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.quiz_results enable row level security;

create policy linux_ar_profiles_select_own
on public.profiles for select to authenticated
using (id = (select auth.uid()));

create policy linux_ar_profiles_update_own
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy linux_ar_telegram_accounts_select_own
on public.telegram_accounts for select to authenticated
using (user_id = (select auth.uid()));
-- No browser INSERT/UPDATE/DELETE policy for Telegram tables.
-- The service-role Edge Function owns all account-link writes.

create policy linux_ar_progress_select_own
on public.lesson_progress for select to authenticated
using (user_id = (select auth.uid()));

create policy linux_ar_progress_insert_own
on public.lesson_progress for insert to authenticated
with check (user_id = (select auth.uid()));

create policy linux_ar_progress_update_own
on public.lesson_progress for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy linux_ar_quiz_results_select_own
on public.quiz_results for select to authenticated
using (user_id = (select auth.uid()));
-- No browser INSERT/UPDATE/DELETE policy: quiz answers are graded server-side.

-- Explicit table grants used together with the RLS policies above.
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.lesson_progress to authenticated;
grant select on public.quiz_results to authenticated;
grant select on public.telegram_accounts to authenticated;

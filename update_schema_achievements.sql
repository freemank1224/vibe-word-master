-- Create user_achievements table
create table if not exists public.user_achievements (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  achievement_id text not null,
  unlocked_at timestamptz default now() not null,

  -- Ensure unique achievements per user
  unique(user_id, achievement_id)
);

-- Enable RLS
alter table public.user_achievements enable row level security;

-- Policies
create policy "Users can view their own achievements"
  on public.user_achievements for select
  using (auth.uid() = user_id);

create policy "Users can insert their own achievements"
  on public.user_achievements for insert
  with check (auth.uid() = user_id);

-- Refresh schema cache
notify pgrst, 'reload schema';

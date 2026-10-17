-- Paper trading schema for Supabase (Postgres).
-- Run once: Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
-- Every table is private to the signed-in user (row-level security). The daily GitHub Action
-- uses the service_role key, which bypasses RLS, so keep that key ONLY in GitHub secrets.

create extension if not exists pgcrypto;

-- one row per user: fee rates and defaults (JSON, edited from the Settings screen)
create table if not exists public.paper_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- money in / out. portfolio IN = rupees; portfolio US = US dollars.
--   IN deposit : amount = INR credited,  inr = INR
--   US deposit : amount = net USD credited, inr = INR sent from the bank; meta holds rate, gst, pay-in fee, TCS...
create table if not exists public.paper_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  portfolio text not null check (portfolio in ('IN','US')),
  kind text not null check (kind in ('deposit','withdrawal')),
  date date not null,
  amount numeric not null check (amount > 0),
  inr numeric,
  meta jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now()
);

-- instructions. status: waiting (bracket child, parent not filled yet) | pending | filled | cancelled | expired | rejected
create table if not exists public.paper_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  portfolio text not null check (portfolio in ('IN','US')),
  symbol text not null,
  yf text not null,
  side text not null check (side in ('BUY','SELL')),
  qty numeric not null check (qty > 0),
  type text not null check (type in ('MARKET','LIMIT','STOP')),
  price numeric,                       -- limit price (LIMIT) or trigger price (STOP)
  after_date date not null,            -- only sessions AFTER this date can fill the order
  expiry date,                         -- last session the order is live (null = until cancelled)
  oco_group text,                      -- orders sharing a group cancel each other when one fills
  parent_id uuid references public.paper_orders(id) on delete cascade,
  stop_ref numeric,                    -- planned stop for a BUY (used for R-multiples)
  tag text,
  note text,
  status text not null default 'pending'
    check (status in ('waiting','pending','filled','cancelled','expired','rejected')),
  status_note text,
  created_at timestamptz not null default now()
);

-- executed trades (made by the engine, or entered/edited by hand)
create table if not exists public.paper_fills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid references public.paper_orders(id) on delete set null,
  portfolio text not null check (portfolio in ('IN','US')),
  symbol text not null,
  yf text not null,
  side text not null check (side in ('BUY','SELL')),
  qty numeric not null check (qty > 0),
  price numeric not null check (price > 0),
  date date not null,
  fees jsonb not null default '{}'::jsonb,   -- itemised charges frozen when the fill was made / last edited
  fees_total numeric not null default 0,
  source text not null default 'auto' check (source in ('auto','manual','edited')),
  stop_ref numeric,
  tag text,
  note text,
  created_at timestamptz not null default now()
);

-- daily closes the engine keeps for every symbol you traded (plus the Nifty 50 and S&P 500 benchmarks)
create table if not exists public.paper_prices (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  yf text not null,
  date date not null,
  close numeric not null,
  primary key (user_id, yf, date)
);

create index if not exists paper_ledger_user_idx on public.paper_ledger (user_id, portfolio, date);
create index if not exists paper_orders_user_idx on public.paper_orders (user_id, status);
create index if not exists paper_fills_user_idx  on public.paper_fills (user_id, portfolio, date);

alter table public.paper_settings enable row level security;
alter table public.paper_ledger   enable row level security;
alter table public.paper_orders   enable row level security;
alter table public.paper_fills    enable row level security;
alter table public.paper_prices   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['paper_settings','paper_ledger','paper_orders','paper_fills','paper_prices'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- safety net: one automatic fill per order, so a re-run of the engine can never fill an order twice
create unique index if not exists paper_fills_one_auto_per_order
  on public.paper_fills (order_id) where order_id is not null and source = 'auto';

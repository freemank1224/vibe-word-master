# Login recovery — 2026-10-25

## Observed failure

Production authentication remained available, but loading the user's word library returned HTTP 500 with `canceling statement due to statement timeout`. The app then displayed its initial cloud-data error screen. Supabase's project health endpoint reported the database as `UNHEALTHY`; database diagnostic connections also timed out, including a minimal read.

The immediate incident was a database availability problem. Its underlying resource or connection failure was not established before recovery. The recently shipped Surf steering and wallet changes did not change this word query or database schema.

## Recovery and mitigation

- Performed one normal restart of the official production Supabase project. Database, Auth, and REST health subsequently returned `ACTIVE_HEALTHY`.
- Confirmed the existing word indexes and row-level security policies were present. No schema, permission, timeout, or user-data changes were needed.
- Removed the competing full-library read from initial learning synchronization. Initial loading owns the full read.
- Background synchronization reads only learning progress, using stable cursor pagination. It no longer loads sessions/media or runs image backlink repairs, and hidden tabs skip polling.
- The cloud-error retry button retries loading in the current page.
- Account identity epochs invalidate old reads before subsequent pages or image work. Full reads remain independent so refreshes after writes cannot reuse an earlier snapshot; only concurrent progress reads are combined.

These frontend changes remove unnecessary work. They are a mitigation, not proof that duplicate reads caused the database outage.

## Verification

- Repeated the reported account's query inside a read-only transaction with the authenticated role and its RLS identity. It returned 834 rows through `idx_words_user_alive`; query execution including JSON serialization took 14.787 ms.
- Logged into the production website through the actual email/password form with a disposable confirmed QA account. Authentication and library requests succeeded.
- Tested the candidate build against the same official Supabase database: one initial full read; injected one client-side read failure; retry succeeded without page navigation; focus performed a narrow progress read; hidden focus/online events issued no progress query.
- Desktop viewport captures: 1366×768, 1440×900, 1920×1080.
- `npm run verify`: application, Node, tests, and Edge Function type checks passed; 461 local tests passed; production build passed. The local total includes 26 pre-existing untracked prototype tests. This change adds 10 tests for progress pagination, retries, identity transitions, and fresh reads after writes.
- Independent code review covered write/read freshness, account transitions, pending local progress, and learning-field mapping.

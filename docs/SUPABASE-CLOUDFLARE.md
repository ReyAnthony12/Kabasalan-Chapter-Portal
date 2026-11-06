# Backend and publishing notes

## Supabase

The live project is `chqsgorcilmtsajkuzsl` in West EU (Ireland). The existing tables were inspected in the dashboard. Full application policies and RPCs require the ordered migrations in DEPLOYMENT.md. It contains:

- `profiles` — Auth-linked members, position, trusted role, and active state.
- `chapter_settings` — monthly amount, deadline, GCash number/QR, and payment visibility options.
- `monthly_dues` — one record per member per calendar month, with Pending/Approved/Rejected status and timestamps.
- `fund_transactions` — income and expenses used to calculate the chapter balance.
- `chapter_posts` — published captions and up to five activity-photo paths.

Every public table has RLS enabled. Admin authorization reads `app_metadata.chapter_role`; role values in user-editable metadata are not trusted. Members can see their own dues and submit only their own GCash proof. Fund writes, reviews, settings, account creation, posts, and cash records require an admin role. Receipt proofs are private; activity and QR photos are public-read.

The frontend uses the publishable key only. The `create-chapter-member` Edge Function uses the server-side service role and checks both the caller's trusted admin claim and active admin profile before creating a member. Never copy a secret/service-role key into this folder or the Cloudflare site.

## Create the first portal admin

The project owner's email and portal login are separate accounts. Use the Supabase dashboard with `reyabog70@gmail.com` to create an Auth user for the chapter administrator, set a password, and place `{ "chapter_role": "admin" }` in **app metadata**. Ensure a matching active admin profile exists; no profile trigger was found. The member-creation Edge Function now provisions member profiles explicitly. Then turn off public sign-ups in Auth settings and sign in to the portal.

## Cloudflare Pages

Cloudflare is not connected to this workspace, so no Pages deployment has been made. Run `npm run build` and publish only the generated `dist` folder as the Pages static site root. The site already contains the project's URL and publishable key; it does not need the service key. After deploy, test admin sign-in, member creation, receipt upload/review, dues status, activity posts on the landing page, and settings from a phone and laptop.

## Receipt retention

Automatic browser cleanup is disabled. Opening the portal never deletes financial evidence or changes approved dues. A separate reviewed server retention job is required before promising automatic deletion. See DEPLOYMENT.md.

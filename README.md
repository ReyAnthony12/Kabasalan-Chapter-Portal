# Kabasalan Chapter Portal

Single-chapter public site and member/admin portal. Live data is hosted by Supabase; the static front end can be published to Cloudflare Pages.

## Folders

- `index.html` — public landing page, sign-in, admin pages, and member pages.
- `public/assets/` — chapter seal and payment QR image.
- `src/scripts/supabase-runtime.js` — Supabase Auth, live chapter posts, members, payments, ledger, and settings.
- `supabase/functions/create-chapter-member/` — admin-only server function for creating member logins.
- `docs/` — database, first-admin, and publishing notes.

## Supabase project

- Project: **Kabasalan Chapter Portal**
- Project ref: `chqsgorcilmtsajkuzsl`
- Region: West EU (Ireland)
- The frontend includes only the project URL and publishable key. No service-role key is stored in the site.
- Database tables and buckets exist, but the full application migration and Edge Function deployment must be verified separately. Source files alone do not prove a live deployment.
- Buckets are `payment-proofs` (private), `chapter-activities` (public photos), and `chapter-qr` (public QR image).
- The `create-chapter-member` Edge Function requires a verified, active administrator and provisions both Auth login and member profile.

## First administrator setup

The Supabase project owner email is not automatically a portal user. To enable the first portal login:

1. Sign in to [Supabase Auth users](https://supabase.com/dashboard/project/chqsgorcilmtsajkuzsl/auth/users) using the project owner account `reyabog70@gmail.com`.
2. Create an Auth user for the chapter administrator email and set its password there.
3. Edit that Auth user's **app metadata** to include `{ "chapter_role": "admin" }`. Do not put the role in user metadata.
4. Ensure the same Auth user ID has a `profiles` row with role `admin` and `is_active = true`. This project does not have a verified Auth-to-profile trigger. Sign in with that portal email/password.
5. Turn off public sign-ups in Supabase Auth settings. Member accounts are then created from **Member accounts** in the portal.

The dashboard owner is reyabog70@gmail.com. The existing portal administrator is admin@kabasalan.com, with an active admin profile. Use its separately configured portal password; no password is embedded in this project.

## Local preview

Serve the project folder over HTTP so the ES module and Supabase Auth can load; opening `index.html` as a `file://` URL can block the module import. For example, use a local PHP/XAMPP or static file server.

## Receipt storage

Payment amount, month, method, submitted date, status, and review date stay in the database. Automatic browser-triggered deletion has been removed: visiting the portal never rejects an approved contribution or deletes its evidence. Receipt retention needs a separate, reviewed server maintenance job; it is not currently scheduled.

## Deployment status

Cloudflare Pages has not been deployed. See [deployment instructions](docs/DEPLOYMENT.md) for the exact migration order, function deployment, tests, and static build. Do not publish the entire development folder; publish only `dist` from `npm run build`.

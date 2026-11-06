# Deployment and verification

The local source audit is complete. A local test is not proof of a live Supabase deployment.

Verified live on November 4, 2026: both authorization/backend repair scripts applied successfully; rollback checks passed for active versus disabled admin and backend function privileges/missing identity. `create-chapter-member` was deployed, and the existing admin session reached its input-validation response. Public self-signup was disabled and confirmed by a fresh Auth settings endpoint response after refreshing the expired dashboard session. The dashboard loaded settings, dues and ledger queries after explicit member relationship selection was added. No real test members, payments or receipt files were created, so the full positive member/upload workflow remains an owner acceptance check.

## Existing project

Target: `chqsgorcilmtsajkuzsl`. Never put a service-role/secret key in browser source or static hosting.

The original schema differs from the frontend contract. Apply the reviewed scripts explicitly in this order using the privileged database migration role:

1. `supabase/migrations/20261104_restore_profile_read.sql` — historical bootstrap policy, already applied to this project. Do not rerun it if present.
2. `supabase/migrations/20261104_active_profile_authorization.sql` — replaces that policy with a current active-admin check.
3. `supabase/migrations/20261104_complete_portal_backend.sql` — compatible columns, atomic payment RPCs, role/ownership policies, public published posts and upload limits.
4. `supabase/migrations/20261104_dues_schedule_officers.sql` — chapter/member dues start months and the editable public seven-officer roster. Applied successfully to the existing project on November 4, 2026; member creation was redeployed with the Member-only initial title.

These scripts are one-time migrations for the verified existing schema, not a fresh-project schema. The shared date prefix is unsuitable for automatic CLI migration discovery; use the explicit order above, or adopt distinct migration versions before a future CLI migration workflow. Do not rerun successful scripts blindly.

The complete backend script preserves legacy columns. It grants active members their own dues/receipts, allows authorized administrators to manage the chapter, and permits public reads only of published posts/public images. Members cannot directly approve dues or write ledger entries. Approval and ledger income are one database transaction. Approved/pending payments cannot be overwritten through receipt submission. Amounts are whole pesos because the existing database uses integer amounts.

Deploy `supabase/functions/create-chapter-member/index.ts` to the same project. It uses server environment credentials, verifies the caller and active administrator profile, creates the member login, then provisions its profile. If profile creation fails it attempts to roll back the newly created login. Do not assume any missing trigger will create a profile.

Verify public signup is disabled in Supabase Auth. Portal account creation goes through the admin-only function. Confirm recovery-email settings before adding a self-service password recovery flow. No password is stored in this repository.

## Chapter administration

Use **Dues schedule** in the admin sidebar to choose the first billable month for the chapter. An individual member can have a different first month; leaving their override empty follows the chapter setting. No chapter start and no member override means dues are not scheduled. Months before the effective start do not count as unpaid, and the server rejects new payments for them. Changing a schedule preserves existing payment history.

Use **7 Masters** to edit the seven public names after an election. Linking an active account is optional and updates its chapter position; removing a linked officer restores the Member title. Elected titles never grant administrator access. Create accounts as Member first, then link them in this roster. The initial roster contains the seven names supplied by the chapter owner; no accounts were created for them.

## Tests and static build

Use Node.js 24 or newer for the test runner's TypeScript stripping:

```text
npm ci
npm run check
npm test
npm run build
```

Tests use isolated local Happy DOM and PostgreSQL (PGlite) fixtures; they do not create live users, payments, or uploads. The backend tests execute the actual migration scripts against a fixture of the verified legacy schema. They do not simulate Supabase HTTP gateways, object-store byte handling or concurrent network requests.

The build packages only `index.html`, `src/`, and `public/` into `dist/`. Publish `dist/` to static hosting. Tests, migration scripts, developer packages, and documentation are excluded.

## Live acceptance checks

- Admin login and logout; a subsequent member session must not retain the administrator's directory, dues, signed proof URLs, draft passwords or uploads.
- Create a disposable member through the admin portal, then sign in as that member. Verify its profile exists.
- Upload a permitted receipt for the configured amount, approve once, and confirm exactly one corresponding income entry. Duplicate submission/approval must fail.
- Verify a member cannot read another member's dues/proofs, approve payments, edit settings or write the ledger directly.
- Verify disabling/downgrading an administrator immediately blocks broader profile access even with an old admin-claim token.
- Verify published posts appear publicly; drafts and private proof objects remain unavailable to anonymous visitors.
- Verify payment-method and member-ledger settings against direct backend calls, not just hidden buttons.

Receipt evidence is not deleted by page visits. A scheduled retention job, backups, monitoring and permanent hosting are separate operational setup. Do not mark them complete without actual deployment evidence.

Apply `supabase/migrations/20261104_member_dues_status.sql` after the dues schedule migration and before publishing the updated frontend. Monthly dues status is independent of login access; inactive dues members retain membership and payment history. Reactivation includes them again in eligible monthly dues counts.


## Missing dues column during login

Login reads only core account columns so an unapplied dues migration cannot prevent authentication. Profile lists read available columns; absent optional dues values use existing defaults. Account activity and trusted role checks remain required. Apply `supabase/migrations/20261104_member_dues_status.sql` once after the schedule migration to enable changing monthly dues status. Rebuild and publish the frontend. This compatibility fix does not apply a live database migration.

Verified live November 4, 2026: applied 20261104_member_dues_status.sql through the project SQL Editor successfully and requested the API schema cache reload. Existing member status values and payment records were retained.

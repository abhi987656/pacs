# Master and user software – Supabase setup

Personal PACS comes in two editions built from the same code:

| Installer | Who uses it | What it does |
| --- | --- | --- |
| `PersonalPACS-Setup-*.exe` (user software) | your users | Opens with **Sign in / Create account** (name, email, password – no email verification). A new account waits until you approve it. |
| `PersonalPACS-Master-Setup-*.exe` (master software) | you | Signs in with your master account. Has a **Users** page: requests (name, email, computer), **Approve** (with how many computers the account may use), **Decline**, **Withdraw**, change the computer limit, **Remove computer**. |

Both are the full PACS (viewer, reporting, liver analysis …). The accounts and approvals live in
your Supabase project; the patients' images and reports never leave the computers.

## One-time setup (about 10 minutes)

1. **Create a Supabase project** – <https://supabase.com> › New project (the free plan works).
   Pick the region closest to you (for example Mumbai). Remember the database password it asks
   for (you do not need it in the app).
2. **Create the tables and rules** – Dashboard › **SQL Editor** › New query › paste all of
   [`schema.sql`](schema.sql) › **Run**. (Running it again later is safe.)
3. **No email verification** – Dashboard › **Authentication** › **Sign In / Providers** › **Email**:
   turn **off** "Confirm email" (keep "Allow new users to sign up" on) › Save.
4. **Your master account** – Dashboard › **Authentication** › **Users** › **Add user** › Create new
   user: your email and a password, "Auto Confirm User" on. Then, in the SQL Editor, run (with
   your email):

   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
   ```

   You can add more master accounts the same way.
5. **The project's address and public key** – Dashboard › **Project Settings** › **API** (or
   **Data API** / **API Keys**): copy the **Project URL** and the **anon / public** key.
   Never use the `service_role` (secret) key anywhere in the app.
6. **Give them to the builds** – on GitHub: the repository › **Settings** › **Secrets and
   variables** › **Actions** › **New repository secret**, twice:
   - `SUPABASE_URL` = the Project URL (like `https://abcdefgh.supabase.co`)
   - `SUPABASE_ANON_KEY` = the anon / public key
7. **Build** – push any change, or GitHub › **Actions** › "Build Windows installer" › **Run
   workflow**. The "Windows app – latest build" release then has both installers.
8. Install **Personal PACS Master** on your computer and sign in with the master account. Give
   your users **PersonalPACS-Setup-*.exe**; their requests appear on your **Users** page (the
   Users icon on the left shows how many are waiting).

## How access works

- **Approve** a request and set how many computers the account may be used on (default 1). Each
  computer the person signs in on takes one place; the Users page lists them (arrow on the left)
  with their name, version and when they were last used. **Remove computer** frees a place, for
  example after a new PC. Lowering the limit does not remove computers already in use.
- The user software checks with Supabase at every start. An approved computer keeps working
  **offline for 7 days** after its last successful check; after that it needs the internet again.
  Setting the computer's clock back does not extend this.
- **Withdraw** locks the account at its next start with internet. A declined or withdrawn person can
  press **Ask again**, which puts the request back on your list.
- **Forgotten password**: there is no email, so no reset link. Delete the user in Supabase ›
  Authentication › Users, then they create the account again and you approve it.
- **Supabase free plan**: projects pause after a week without any use. The users' daily starts
  keep it awake; if it does pause, open the dashboard and press **Restore** (approved computers
  keep working offline meanwhile, for up to 7 days).
- Builds made without the two secrets have no sign-in at all (the build log warns about it).
- The rules in Supabase (row level security, `schema.sql`) only let a person read their own
  request; only master accounts can approve, see the list, or change limits. The check inside the
  app stops normal use without approval; like any desktop licence check it is not meant to stop
  someone who takes the program apart.

# Self-serve portrait uploads (Supabase, free)

This lets each player upload their own portrait + name via a password-protected
page (`https://extension-dnd.onrender.com/admin`). No Git, no host editing.
The browser extension does NOT change, so no new Chrome review is needed.

## 1. Create a free Supabase project
1. Sign up at https://supabase.com (free tier).
2. New project → give it a name + a database password (you won't need that
   password for this). Wait ~1 min for it to provision.

## 2. Create the characters table
Open **SQL Editor** → New query → run this:

```sql
create table characters (
  discord_id  text primary key,
  name        text not null,
  portrait_url text,
  updated_at  timestamptz default now()
);
```

## 3. Create the storage bucket
1. Left menu → **Storage** → **New bucket**.
2. Name it exactly: `portraits`
3. Toggle **Public bucket** ON. Create.

## 4. Get your keys
Left menu → **Project Settings** → **API**:
- **Project URL** (looks like `https://abcd1234.supabase.co`)
- **service_role** key (under "Project API keys" — click reveal). This is
  SECRET; it only goes into Render, never into the extension.

## 5. Add the env vars on Render
Render → your **extension-dnd** service → **Environment** → add:

| Key                   | Value                                            |
|-----------------------|--------------------------------------------------|
| `SUPABASE_URL`        | your Project URL                                 |
| `SUPABASE_SERVICE_KEY`| your service_role key                            |
| `ADMIN_PASSWORD`      | a password you choose and share with players     |
| `CAMPAIGN_NAME`       | optional, e.g. "Curse of Strahd"                 |

Save (Render will redeploy).

## 6. Push the updated relay code
From the project folder:
```
git add -A
git commit -m "Supabase self-serve portrait uploads"
git push
```
Render auto-redeploys with the new code.

## 7. Test
- Open `https://extension-dnd.onrender.com/health` → should say `"mode":"supabase"`.
- Open `https://extension-dnd.onrender.com/admin` → upload a portrait using your
  Discord ID, a name, and the ADMIN_PASSWORD.
- Open `https://extension-dnd.onrender.com/campaign.json` → your character shows up.
- Reload Roll20 → portrait appears and lights up when you talk.

## How players use it
Send them two things: the link `https://extension-dnd.onrender.com/admin` and
the group password. They open it, paste their Discord User ID, type their
character name, pick an image, enter the password, and hit Upload. Done — it's
live for everyone immediately.

## Notes
- Once Supabase mode is on, the old `config/campaign.json` + `config/portraits/`
  are ignored; the database is the source of truth. So you (the host) also
  upload yourself via /admin.
- To change/remove someone: re-upload overwrites their portrait. To delete a
  character, remove its row in the Supabase **Table Editor**.
- The service_role key stays only in Render. Players only ever see the /admin
  page and the group password.

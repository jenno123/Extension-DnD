# Multi-tenant rooms — setup

Each group now plays in its own room (a campaign code). Groups are fully
isolated: different campaigns never see each other's portraits. The code is the
access credential (like a meeting link). Creating a campaign needs your
ADMIN_PASSWORD; joining one only needs the code.

## 1. Update the Supabase schema (run once)
Supabase → SQL Editor → run:

```sql
create table if not exists campaigns (
  room text primary key,
  name text not null,
  created_at timestamptz default now()
);

-- characters are now scoped per room (old test rows are dropped)
drop table if exists characters;
create table characters (
  room text not null,
  char_id text not null,
  name text not null,
  portrait_url text,
  updated_at timestamptz default now(),
  primary key (room, char_id)
);
```

No new env vars needed — ADMIN_PASSWORD (already set) now also guards campaign
creation.

## 2. Push the relay
```
git add -A
git commit -m "Multi-tenant rooms"
git push
```
Render redeploys. Check /health → `"mode":"supabase"`.

## 3. Create your first campaign
Open `https://extension-dnd.onrender.com/create`, enter a campaign name and your
ADMIN_PASSWORD → you get a **campaign code** (e.g. `RAVEN7`) and the player link.

## 4. Players join (per campaign)
Send each player:
- the link `https://extension-dnd.onrender.com/mic?room=RAVEN7`
- (and once the v1.4.0 extension is approved) tell them to put `RAVEN7` in the
  extension popup's **Campaign code** field.

On the /mic page they add their portrait + name and start their mic — scoped to
that campaign only.

## 5. Extension v1.4.0
The overlay extension now has a **Campaign code** field and must be updated:
upload `dnd-overlay-chrome-v1.4.0.zip` to the Chrome Web Store as a new version.
Until it's approved you can test by loading it unpacked.

## Heads-up
- After this deploy the OLD published extension (v1.2.0) shows nothing, because
  data is now per-room and the default room is empty. Use v1.4.0 + a campaign
  code from /create.
- To add more groups later, just open /create again — each gets its own code.

## What this unlocks
This is the foundation for "many users": isolated rooms, per-campaign data, and
a clean join-by-code flow. DM mode and premium art now build cleanly on top.

# mech_bridge

A tiny FiveM server resource that reads your in-game **ox_inventory stashes**
(managed by unexis_stashes) and pushes the item counts to the **Mech Shop
Manager** app, so the app's stock mirrors the game live.

It runs inside your FXServer and uses **oxmysql** (already connected) — no Node,
no extra process, no DB credentials to re-enter.

## Prerequisites
- The app is deployed with the `/api/sync/stock` endpoint and the env var
  `STASH_SYNC_TOKEN` set (same value you put in `config.lua`).
- `oxmysql` and `ox_inventory` are running on the server.

## Install (on the VPS)
1. Copy this `mech_bridge` folder into your server's resources, e.g.
   `resources/[local]/mech_bridge`.
2. Edit **config.lua**:
   - `AppUrl` → your app URL (e.g. `https://mech-manager.vercel.app`)
   - `SyncToken` → a long random string; set the **same** value as
     `STASH_SYNC_TOKEN` on the app.
   - leave `StashMap` empty for now.
3. In `server.cfg`, add (AFTER `ensure oxmysql` and `ensure ox_inventory`):
   ```
   ensure mech_bridge
   ```
4. Start/restart the server (or `refresh` then `ensure mech_bridge` in console).

## Find your stash names, then map them
1. In the **server console** (txAdmin live console) run:
   ```
   mechbridge_list
   ```
   It prints every stash NAME and its items.
2. Copy the NAME(s) for each shop into `config.lua` → `Config.StashMap`, e.g.
   ```lua
   Config.StashMap = {
     ['Angels_parts_bin_1'] = 3,  -- 3 = the shop id in the app
     ['LSC_main_stash_1']   = 1,
   }
   ```
3. `restart mech_bridge` in console.

It now syncs every `IntervalSeconds` (default 60). Force one with
`mechbridge_sync`. Item names from the stash map onto the app's stock by name
(turbo_lvl_3, ceramic_brakes, …); unmatched items are created in the app's stock.

## Performance (resmon)
Built to sit at **~0.00ms** when idle:
- One background thread that **sleeps** `IntervalSeconds` between runs — no
  per-frame/tick work, no event handlers.
- Each wake does only a tiny indexed `SELECT name, lastupdated` check.
- It fetches the heavy item `data` and makes an HTTP call **only when a stash
  actually changed** since last sync — so if nothing's happening in the stash,
  it does essentially nothing.
- Want it even lighter? Raise `Config.IntervalSeconds` (e.g. 120–300) and set
  `Config.Debug = false`.

## Troubleshooting
- `sync FAILED (401)` → token mismatch between `config.lua` and the app.
- `sync FAILED (503)` → the app has no `STASH_SYNC_TOKEN` set.
- `mechbridge_list` shows nothing → no stashes configured in-game yet, or the
  inventory isn't ox_inventory.

Config = {}

-- Your Mech Shop Manager app URL (no trailing slash)
Config.AppUrl = 'https://mech-manager.vercel.app'

-- Must EXACTLY match the STASH_SYNC_TOKEN env var set on the app (Vercel).
-- Make it long and random. Keep this file private.
Config.SyncToken = 'CHANGE_ME_to_a_long_random_string'

-- How often to push stash stock to the app (seconds)
Config.IntervalSeconds = 60

-- Map each ox_inventory stash NAME  ->  your app shop id.
-- Run  mechbridge_list  in the server console to see the real stash names.
-- Several stashes can point at the same shop (their item counts are summed).
Config.StashMap = {
  -- ['Angels_parts_bin_1'] = 3,
  -- ['LSC_main_stash_1']   = 1,
}

-- Print a line to the server console each time it syncs
Config.Debug = true

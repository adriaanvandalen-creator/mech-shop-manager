-- mech_bridge — reads ox_inventory stashes and pushes counts to the app.
-- Built to sit at ~0.00ms on resmon: one idle thread that wakes on an interval,
-- a cheap `lastupdated` check first, and real DB/HTTP work ONLY when a stash changed.

-- shop id -> { stashName, ... }  (precomputed once; reverse of Config.StashMap)
local shopStashes = {}
-- stashName -> last seen `lastupdated` value (change detection)
local lastSeen = {}
-- cached placeholder lists so we don't rebuild strings every cycle
local allNames, allPlaceholders = {}, ''

local function buildMaps()
  shopStashes, allNames = {}, {}
  for stash, shop in pairs(Config.StashMap) do
    shopStashes[shop] = shopStashes[shop] or {}
    shopStashes[shop][#shopStashes[shop] + 1] = stash
    allNames[#allNames + 1] = stash
  end
  local ph = {}
  for i = 1, #allNames do ph[i] = '?' end
  allPlaceholders = table.concat(ph, ',')
end

-- Parse an ox_inventory `data` JSON string → { itemname = totalcount }
local function aggregate(dataStr)
  local out = {}
  if not dataStr or dataStr == '' then return out end
  local ok, slots = pcall(json.decode, dataStr)
  if not ok or type(slots) ~= 'table' then return out end
  for _, s in pairs(slots) do
    if type(s) == 'table' and s.name then
      local n = string.lower(s.name)
      out[n] = (out[n] or 0) + (tonumber(s.count or s.amount) or 0)
    end
  end
  return out
end

local function postShop(shopId, items)
  PerformHttpRequest(Config.AppUrl .. '/api/sync/stock', function(status, text)
    if status == 200 then
      if Config.Debug then print(('[mech_bridge] shop %s synced: %s'):format(shopId, text or '')) end
    else
      print(('[mech_bridge] ^1shop %s sync FAILED (%s): %s^7'):format(shopId, status, text or ''))
    end
  end, 'POST', json.encode({ shopId = shopId, items = items }),
    { ['Content-Type'] = 'application/json', ['x-sync-token'] = Config.SyncToken })
end

-- Re-read ALL of a shop's stashes, aggregate, and push (keeps multi-stash shops correct)
local function syncShop(shopId)
  local stashes = shopStashes[shopId]
  if not stashes or #stashes == 0 then return end
  local ph = {}
  for i = 1, #stashes do ph[i] = '?' end
  local rows = MySQL.query.await('SELECT name, data, lastupdated FROM ox_inventory WHERE name IN (' .. table.concat(ph, ',') .. ')', stashes)
  local items = {}
  if rows then
    for _, row in ipairs(rows) do
      lastSeen[row.name] = row.lastupdated and tostring(row.lastupdated) or 'x'
      for n, c in pairs(aggregate(row.data)) do items[n] = (items[n] or 0) + c end
    end
  end
  postShop(shopId, items)
end

local function syncOnce(force)
  if #allNames == 0 then return end -- nothing mapped → do nothing (no DB, no spam)

  -- Cheap pass: only the tiny `lastupdated` column, not the big `data` blobs.
  local affected = {}
  if force then
    for shop in pairs(shopStashes) do affected[shop] = true end
  else
    local rows = MySQL.query.await('SELECT name, lastupdated FROM ox_inventory WHERE name IN (' .. allPlaceholders .. ')', allNames)
    if rows then
      for _, r in ipairs(rows) do
        local lu = r.lastupdated and tostring(r.lastupdated) or 'x'
        if lastSeen[r.name] ~= lu then
          local shop = Config.StashMap[r.name]
          if shop then affected[shop] = true end
        end
      end
    end
    -- first boot: lastSeen empty → sync everything once
    if next(lastSeen) == nil then for shop in pairs(shopStashes) do affected[shop] = true end end
  end

  -- Heavy work (data fetch + HTTP) ONLY for shops whose stash actually changed
  for shop in pairs(affected) do syncShop(shop) end
end

CreateThread(function()
  Wait(3000) -- let oxmysql settle on boot
  buildMaps()
  while true do
    pcall(syncOnce, false)
    Wait((Config.IntervalSeconds > 0 and Config.IntervalSeconds or 60) * 1000)
  end
end)

-- Console: list every ox_inventory stash + its items (find names for StashMap)
RegisterCommand('mechbridge_list', function(source)
  if source ~= 0 then return end
  CreateThread(function()
    local rows = MySQL.query.await('SELECT name, data FROM ox_inventory ORDER BY name', {})
    print('[mech_bridge] ===== ox_inventory stashes =====')
    if rows and #rows > 0 then
      for _, row in ipairs(rows) do
        local parts = {}
        for n, c in pairs(aggregate(row.data)) do parts[#parts + 1] = n .. '×' .. c end
        print(('  NAME: %s  |  %s'):format(row.name, #parts > 0 and table.concat(parts, ', ') or '(empty)'))
      end
    else
      print('  (no stash rows found)')
    end
    print('[mech_bridge] ================================')
  end)
end, true)

-- Console: force a full sync now (ignores change detection)
RegisterCommand('mechbridge_sync', function(source)
  if source ~= 0 then return end
  CreateThread(function() buildMaps(); pcall(syncOnce, true); print('[mech_bridge] manual sync done') end)
end, true)

print('[mech_bridge] started — change-detect sync every ' .. Config.IntervalSeconds .. 's. Console: mechbridge_list / mechbridge_sync')

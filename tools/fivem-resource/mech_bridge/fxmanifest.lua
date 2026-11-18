fx_version 'cerulean'
game 'gta5'

name 'mech_bridge'
description 'Syncs ox_inventory stash stock to the Mech Shop Manager app'
author 'Frikkie Botha'
version '1.0.0'

-- oxmysql gives us MySQL.query.await; ensure oxmysql starts before this resource
shared_script '@oxmysql/lib/MySQL.lua'

server_scripts {
  'config.lua',
  'server/main.lua'
}

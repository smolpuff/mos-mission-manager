## core

- refactor pages into their own pages in ./pages as opposed to all on 1
- audit for security
- check toodo.md for wallet security things.
- migrate from electron to other one bc this shits huge!

## general UI related

- started mission status STILL HANGS for a long time and flashes weird. have it 1 not flash all crazy and 2 not last so long after hte mission it stays way too long. i dont know why it should be for like 5 maybe?
- error with reset make it outline teh nft that has the error with an I icon overlay. have that open a modal that has the message on it and details. need visual like HEY I NEED ATTENTION

- fix win 11 secure storage, failed on create. screenshot.
- need to be able to import wallet made elsewhere for burner <-- WHATEVER IS NEEDED NORMALLY

- create generated app wallet UI modal(s): confirm it creates, shows checkmark, address, and recovery phrase (hidden by default, reveal works)

- secret keys modal: verify "backend must be running" message when stopped; verify phrase loads when running <-- can this be changed os ti DOESNT need to be running

## windows test checklist

- signer vault storage: verify windows DPAPI/key store works (no vault key read/write errors; reveal backup works after restart)
- funding wallet balance refresh: verify it loads once at startup, then refreshes only after token-affecting actions (no RPC spam / no flicker)

## mish'tish

- get results
- style it all

## my nfts

- Make the the mission card (the individual nft div) section on the mission homepage a component so we can reuse it quickly
- use mcp tool if possible to get the users NFTs, then print them out in a grid grid-cols-6 gap-4 using that component for the overall markup structure, i will restyle it a bit. make the overflow of the nft grid scroll with a scroll bar that I can style if possible. make sure theres room for windows and linux bars i dknot ohow the sizes

## stats

- tell me, and log the list to file, all the stats/analytics you can, or do collect. id like a stats page with info for how many nfts used/what missions were claimed/how many resets/ how much it made you over all in tokens/cost you in resets, succes rates, ets so we need a list of the possibilities.

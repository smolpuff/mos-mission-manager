## core

- refactor pages into their own pages in ./pages as opposed to all on 1

- tell me, and log the list to file, all the stats/analytics you can, or do collect. id like a stats page with info for how many nfts used/what missions were claimed/how many resets/ how much it made you over all in tokens/cost you in resets, succes rates, ets so we need a list of the possibilities.

## general UI related

- temporarily grayout and disable mode 3 and 4 for now until i set them up logic wise (auto optimize + 7day? full rental?)

## windows test checklist

- create generated app wallet (UI modal): confirm it creates, shows checkmark, address, and recovery phrase (hidden by default, reveal works)
- copy buttons in modals (address + phrase): verify copy works and shows "Copied" feedback
- secret keys modal: verify "backend must be running" message when stopped; verify phrase loads when running
- signer vault storage: verify windows DPAPI/key store works (no vault key read/write errors; reveal backup works after restart)
- funding wallet balance refresh: verify it loads once at startup, then refreshes only after token-affecting actions (no RPC spam / no flicker)

## mish'tish

- get prizes
- style it all

## my nfts

- Make the the mission card (the individual nft div) section on the mission homepage a component so we can reuse it quickly
- use mcp tool if possible to get the users NFTs, then print them out in a grid grid-cols-6 gap-4 using that component for the overall markup structure, i will restyle it a bit. make the overflow of the nft grid scroll with a scroll bar that I can style if possible. make sure theres room for windows and linux bars i dknot ohow the sizes

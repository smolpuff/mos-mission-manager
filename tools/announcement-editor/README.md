# Local announcement editor

Run this from the Missions project folder:

```sh
npm run announcements:editor
```

Open the localhost address printed in the terminal. Keep the terminal running while editing; Ctrl+C closes it. Publishing uses your existing GitHub CLI (`gh`) login, with write access to `smolpuff/mos-mission-manager`.

## Create and post an announcement

1. Click **+ New announcement**. Its ID automatically increases (`announcement-1`, `announcement-2`, …), and Starts defaults to today's current time. The ID counter is saved locally across editor restarts and deletions.
2. In **Message**, add an image, title and/or text. Blank sections stay hidden. Image-only announcements work. Images fill the popup width by default; use **Image URL, width & description** to choose an HTTPS image or change its width. PNG, JPEG, WebP and GIF uploads can be up to 5 MB.
3. In **Prizes & rules**, optionally add prize rows (`1st`, `2nd`, `5th–10th`), rules and a details link. Prizes appear above rules in the popup.
4. Set Starts and Ends below the message fields. Scheduling, the announcement ID, and Publish / Remove are always visible in the main editor. Times use the time zone displayed there and are converted to UTC automatically. Keep the generated ID, or edit it before publishing.
5. Click **Preview popup** to see the actual app popup, including its background, overlay and shadow. Preview ignores the schedule.
6. Click **Publish** to post **this announcement only**. If it is already published, Publish updates it. Other published announcements stay unchanged.

**Save local draft** saves your work only on this computer, in the ignored `.local/` folder. It sends nothing. You do not need to check an inclusion checkbox or publish the entire list.

## Remove an announcement

Select it, open **Schedule & publish**, and click **Remove**.

- A published announcement is removed from the app feed and your local list. Other announcements stay unchanged. Apps stop showing it on their next check (up to 30 minutes, plus GitHub cache delay).
- A local-only draft is removed locally; no GitHub request is made.
- Announcements also expire automatically at their Ends time.

To manage messages published from another computer, expand **Load from GitHub** in the sidebar and click **Load published messages**. Published messages are loaded for editing/removal; local-only drafts are kept.

Keep an announcement's ID for corrections, so people who already saw it are not notified again. Changing a published message's ID replaces that entry with the new ID and makes it a new announcement to recipients. IDs already used by another published announcement are rejected.

## Delivery

Publishing/removing changes only the dedicated `announcements` branch, its `announcements.json`, and uploaded images. It never pushes your source branch, edits `version.json`, changes main/beta feeds, creates tags or releases, or deploys your website.

Apps with announcement support check after setup and the guided tour, then every 30 minutes. Automatic delivery happens once per announcement ID, remembered across restarts. Displaying a message at startup also consumes its automatic delivery, so later checks cannot repeat it. Startup can still show an active message on each launch unless explicitly suppressed. Only the initial startup popup has **Don’t show this announcement again**, which remembers suppression across restarts for that ID. Later popups have Dismiss only; they never auto-deliver again, but can still appear at startup until explicitly suppressed. Future messages wait for Starts; expired messages never show, and an open popup closes at Ends or when a check finds it removed. Existing dialogs take priority. Multiple announcements do not appear back-to-back. Feed checks bypass cached URLs, and a failed check discards the old feed. Offline, missing or invalid feeds never block missions. Your website receives no announcement traffic.

Message and Rules / extra info support plain HTTPS URLs and Markdown links such as `[View my stats](https://missions.lol/missions-analytics/{wallet})`. In URLs, `{wallet}` is replaced with the reader’s current game wallet ID. The Details link also supports `{wallet}`. Wallet links stay inactive until the app knows the wallet; the editor preview has no reader wallet. HTML is displayed as text.

This capability must first ship in an app release. Older builds cannot receive these popups.

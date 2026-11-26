# Turkey Day Best Ball

A one-day best ball draft for the Thanksgiving NFL slate, with live full-PPR scoring.
Static site, no backend: open it, set up 4–8 drafters, run a snake draft from one screen,
then send everyone the share link to follow the live leaderboard.

- **Draft state** lives in the host's browser (localStorage). The share link carries a
  read-only snapshot of the rosters.
- **Live stats** come straight from ESPN's public box-score feed in each viewer's browser.
- **ADP** is a rank by projected PPR value over a replacement player at each position
  (Sleeper week projections). Nobody publishes real ADP for a one-day slate.
- **Commissioner PIN** locks undo, reset and score adjustments on the host device. It is a
  courtesy lock, not security: everything runs client-side.

## Phone drafting (`/live/`)

`live/` is a separate copy of the app where everyone drafts from their own phone. The host
sets up and starts the draft there, then sends the join link. Each guest taps their name and
gets a Draft button on their turn; the host screen can still pick for anyone.

The host's browser is the source of truth. It publishes a snapshot after every change and
validates pick requests from guests, through [ntfy.sh](https://ntfy.sh), a free public
pub/sub relay (no account). The random room code in the join link is the only key, and team
names and picks pass through that relay. Keep the host tab open during the draft. The main
site at `/` does not use the relay at all.

## Saving and locking a draft

Every pick is saved in the host's browser, so a refresh keeps the draft. For a durable copy,
open **Commish → Download draft file**. That `draft.json` can be loaded back with
**Restore from file** on any device.

To lock the final rosters for everyone, commit that file to the repo as `data/draft.json`.
The plain site link then shows those rosters, view only, with live scores. While a draft is
locked, add `?host` to the URL to reach the host's own draft and the Commish tab. To unlock,
set `data/draft.json` back to `null`.

## Scoring (full PPR)

Passing 1 pt / 25 yd, 4 per TD, −1 per INT. Rushing and receiving 1 pt / 10 yd, 6 per TD,
1 per reception. Return TD 6, two-point conversion 2, fumble lost −2. Default lineup:
QB, RB, 2 WR/TE, FLEX, with the rest on the bench.

## Rebuild the player pool

```bash
python3 tools/build_pool.py
```

Edit `SEASON`, `WEEK` and `SLATE_DATE` at the top of the script (and `SLATE_DATE` in
`app.js`) for a different slate.

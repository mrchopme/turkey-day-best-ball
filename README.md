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

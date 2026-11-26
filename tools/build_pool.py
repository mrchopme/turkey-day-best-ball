#!/usr/bin/env python3
"""Build data/players.json for the Thanksgiving slate.

Joins Sleeper's weekly PPR projections with ESPN roster ids (ESPN ids are what
the live box score uses), then ranks players by projected value over a
replacement-level player at the same position. That rank is the "ADP" shown in
the app: nobody publishes real draft ADP for a one-day slate.

Usage: python3 tools/build_pool.py   (run from the repo root; needs network)
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SEASON, WEEK, SLATE_DATE = 2026, 12, "20261126"
ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
SLEEPER = (
    f"https://api.sleeper.app/projections/nfl/{SEASON}/{WEEK}?season_type=regular"
    "&position%5B%5D=QB&position%5B%5D=RB&position%5B%5D=WR&position%5B%5D=TE&order_by=pts_ppr"
)
# Sleeper abbreviation -> ESPN abbreviation where they differ
TEAM_FIX = {"WAS": "WSH", "JAC": "JAX", "LA": "LAR"}
# Replacement level per position: the Nth-best projection is worth zero.
BASELINE = {"QB": 6, "RB": 9, "WR": 14, "TE": 6}
MIN_PROJ = 1.0


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "slate-pool-builder"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def norm(name):
    name = name.lower()
    name = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", name)
    return re.sub(r"[^a-z]", "", name)


def main():
    board = get(f"{ESPN}/scoreboard?dates={SLATE_DATE}")
    games, teams = [], {}
    for ev in board["events"]:
        comp = ev["competitions"][0]
        sides = {c["homeAway"]: c["team"] for c in comp["competitors"]}
        games.append({
            "id": ev["id"],
            "date": ev["date"],
            "short": ev["shortName"],
            "home": sides["home"]["abbreviation"],
            "away": sides["away"]["abbreviation"],
        })
        for side, other in (("home", "away"), ("away", "home")):
            t = sides[side]
            teams[t["abbreviation"]] = {
                "espnId": t["id"],
                "opp": sides[other]["abbreviation"],
                "home": side == "home",
                "gameId": ev["id"],
                "color": t.get("color"),
                "name": t.get("displayName"),
            }

    # ESPN ids by (team, normalized name)
    espn = {}
    for abbr, t in teams.items():
        roster = get(f"{ESPN}/teams/{t['espnId']}/roster")
        for group in roster["athletes"]:
            for a in group["items"]:
                espn[(abbr, norm(a["fullName"]))] = a["id"]

    players, missing = [], []
    for row in get(SLEEPER):
        team = TEAM_FIX.get(row.get("team"), row.get("team"))
        if team not in teams:
            continue
        p = row["player"]
        pos = p.get("position")
        proj = round(float(row["stats"].get("pts_ppr") or 0), 1)
        if pos not in BASELINE or proj < MIN_PROJ:
            continue
        name = f"{p['first_name']} {p['last_name']}"
        eid = espn.get((team, norm(name)))
        if not eid:
            missing.append(f"{name} ({team})")
        players.append({
            "id": eid or f"s{row['player_id']}",
            "name": name,
            "pos": pos,
            "team": team,
            "opp": teams[team]["opp"],
            "home": teams[team]["home"],
            "gameId": teams[team]["gameId"],
            "proj": proj,
            "inj": p.get("injury_status"),
        })

    # Value over replacement -> overall rank ("ADP")
    for pos, n in BASELINE.items():
        group = sorted((x for x in players if x["pos"] == pos), key=lambda x: -x["proj"])
        base = group[min(n, len(group)) - 1]["proj"] if group else 0
        for i, x in enumerate(group, 1):
            x["posRank"] = i
            x["_vor"] = x["proj"] - base
    players.sort(key=lambda x: (-x["_vor"], -x["proj"]))
    for i, x in enumerate(players, 1):
        x["adp"] = i
        del x["_vor"]

    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "season": SEASON,
        "week": WEEK,
        "source": "Sleeper week projections (RotoWire), full PPR; ids from ESPN rosters",
        "games": games,
        "teams": teams,
        "players": players,
    }
    path = Path(__file__).resolve().parent.parent / "data" / "players.json"
    path.write_text(json.dumps(out, indent=1))
    print(f"{len(players)} players -> {path}")
    if missing:
        print("no ESPN id (name-match fallback at runtime):", ", ".join(missing), file=sys.stderr)


if __name__ == "__main__":
    main()

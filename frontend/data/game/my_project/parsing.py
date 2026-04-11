import csv
import re
from pathlib import Path

from my_project.models import Card, Contract, MarketTrack, Resource, ResourceAmount

RESOURCE_ALIASES: dict[str, str] = {"H20": "H2O"}


def parse_resource_amount(token: str) -> ResourceAmount:
    """Parse '1 FE', '+2 PWR', '-1 H2O' into ResourceAmount."""
    token = token.strip()
    match = re.match(r"([+-]?\d+)\s+(\w+)", token)
    if not match:
        raise ValueError(f"Cannot parse resource amount: {token!r}")
    amount = int(match.group(1))
    res_str = RESOURCE_ALIASES.get(match.group(2), match.group(2))
    return ResourceAmount(resource=Resource(res_str), amount=amount)


def parse_resource_list(raw: str) -> list[ResourceAmount]:
    """Parse comma-separated resource amounts. Returns empty list for empty/blank string."""
    if not raw or not raw.strip():
        return []
    return [parse_resource_amount(t) for t in raw.split(",")]


def parse_cards(path: Path) -> list[Card]:
    """Parse Cards.csv into a list of Card objects."""
    cards: list[Card] = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            alternate = row["Alternate"].strip()
            if alternate == "Contract":
                can_sell: list[Resource] = []
                can_fulfill_contract = True
            else:
                can_sell = [Resource(r.strip()) for r in alternate.split("/")]
                can_fulfill_contract = False

            cards.append(
                Card(
                    alternate=alternate,
                    slot=int(row["Slot"]),
                    building=row["Building"].strip(),
                    costs=parse_resource_list(row["Cost"]),
                    rates=parse_resource_list(row["Rates"]),
                    effect=row["Effect"].strip(),
                    can_sell=can_sell,
                    can_fulfill_contract=can_fulfill_contract,
                )
            )
    return cards


def parse_contracts(path: Path) -> list[Contract]:
    """Parse Contracts.csv into a list of Contract objects."""
    contracts: list[Contract] = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            requirements: list[ResourceAmount] = []
            for col in ("Resource1", "Resource2", "Resource3"):
                val = row[col].strip()
                if val:
                    requirements.append(parse_resource_amount(val))
            reward = int(row["Reward"].replace("$", ""))
            count = int(row["Count"])
            contracts.append(Contract(requirements=requirements, reward=reward, count=count))
    return contracts


def parse_patents(path: Path) -> list[Card]:
    """Parse Patents.csv into a list of Card objects.

    Patents are modeled as Cards (they ride in Player.buildings_played) but
    have no purchase cost — they're awarded by the Patent Auction event.
    The CSV columns are: Name, Power. Power is the human-readable rules
    text; the corresponding mechanical effect is wired up via patent hooks
    in simulation.py keyed on the patent name. Patents have no inherent
    rates of their own (the rate effects come from the build hooks).
    """
    patents: list[Card] = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            patents.append(
                Card(
                    alternate="Patent",
                    slot=5,  # patents are slot 5, distinct from buildings
                    building=row["Name"].strip(),
                    costs=[],
                    rates=[],  # patents have no inherent rates
                    effect=row["Power"].strip(),
                    can_sell=[],
                    can_fulfill_contract=False,
                )
            )
    return patents


def parse_market(path: Path) -> list[MarketTrack]:
    """Parse market.csv (no header row) into MarketTrack objects."""
    tracks: list[MarketTrack] = []
    with open(path, newline="") as f:
        reader = csv.reader(f)
        for row in reader:
            res_str = RESOURCE_ALIASES.get(row[0].strip(), row[0].strip())
            resource = Resource(res_str)
            prices = [int(p.strip()) for p in row[1:]]
            tracks.append(MarketTrack(resource=resource, prices=prices))
    return tracks


# --- New data-driven parsers ---


def parse_news(path: Path) -> list[dict]:
    """Parse News.csv into news card dicts.

    Returns a list of dicts:
        {"name": str, "effects": [{"kind": str, "payload": dict}, ...]}

    Effect types:
      - rate_all: payload = {"PWR": -1, "O2": -1, ...}
      - market_random: payload = {"resources": ["H2O", ...], "rolls": 1}
      - market_random_x2: payload = {"resources": ["PWR"], "rolls": 2}
      - trigger: payload = {"event": "power_bill"|...}
      - (empty): no effects (e.g. "All Quiet")
    """
    news: list[dict] = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row["Name"].strip()
            kind = row["Type"].strip()
            payload_raw = row["Payload"].strip()
            effects: list[dict] = []
            if kind == "rate_all":
                # Payload like "PWR: -1, O2: -1"
                d: dict[str, int] = {}
                for token in payload_raw.split(","):
                    token = token.strip()
                    if ":" in token:
                        k, v = token.split(":", 1)
                        res_str = RESOURCE_ALIASES.get(k.strip(), k.strip())
                        d[res_str] = int(v.strip())
                effects.append({"kind": "rate_all", "payload": d})
            elif kind == "market_random":
                resources = [
                    RESOURCE_ALIASES.get(r.strip(), r.strip())
                    for r in payload_raw.split(",")
                ]
                effects.append({"kind": "market_random", "payload": {"resources": resources, "rolls": 1}})
            elif kind == "market_random_x2":
                resources = [
                    RESOURCE_ALIASES.get(r.strip(), r.strip())
                    for r in payload_raw.split(",")
                ]
                effects.append({"kind": "market_random", "payload": {"resources": resources, "rolls": 2}})
            elif kind == "trigger":
                effects.append({"kind": "trigger", "payload": {"event": payload_raw}})
            # else: no effects (empty kind)
            news.append({"name": name, "effects": effects})
    return news


def parse_corporations(path: Path) -> list[tuple[str, dict[str, int]]]:
    """Parse Corporations.csv into a list of (name, rates_dict) tuples.

    Rates dict maps resource value strings (e.g. "PWR") to starting rate
    deltas. Zero entries are omitted.
    """
    corps: list[tuple[str, dict[str, int]]] = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row["Name"].strip()
            rates: dict[str, int] = {}
            for col in reader.fieldnames or []:
                if col == "Name":
                    continue
                val = int(row[col].strip() or "0")
                if val != 0:
                    rates[col] = val
            corps.append((name, rates))
    return corps


def parse_patent_values(path: Path) -> dict[str, int]:
    """Read the AI_Value column from Patents.csv into a {name: value} dict.

    Falls back to 0 for patents missing the column (backward-compatible
    with older CSV versions that lack AI_Value).
    """
    values: dict[str, int] = {}
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row["Name"].strip()
            raw = (row.get("AI_Value") or "0").strip()
            values[name] = int(raw) if raw else 0
    return values


def _condition_matches(condition: str, num_players: int) -> bool:
    """Check whether a player-count condition string matches.

    Supported formats:
      ""      → always matches
      "2"     → exactly 2 players
      "3"     → exactly 3 players
      "3+"    → 3 or more players
      "4+"    → 4 or more players
      "2-3"   → 2 to 3 players
    """
    condition = condition.strip()
    if not condition:
        return True
    if "-" in condition:
        lo, hi = condition.split("-", 1)
        return int(lo) <= num_players <= int(hi)
    if condition.endswith("+"):
        return num_players >= int(condition[:-1])
    return num_players == int(condition)


def parse_event_counts(path: Path, num_players: int) -> dict[str, int]:
    """Parse Events.csv into per-event-type counts for the given player count.

    The CSV has columns: Count, Event, Condition, Redraw.
    - Count: how many copies of this event to include.
    - Event: the EventType value string (e.g. "news_bulletin").
    - Condition: player-count filter (empty=always, "2"=2P only, "3+"=3+P,
      "2-3"=2-3P, "4+"=4+P).
    - Redraw: "true" if draw_building_card should have the redraw flag.

    Returns a dict like:
        {"news_bulletin": 3, "debt_collection": 2, ...,
         "draw_building": 5, "draw_building_redraw": 5}

    draw_building_card rows without Redraw count toward "draw_building";
    rows with Redraw="true" count toward "draw_building_redraw".
    """
    counts: dict[str, int] = {
        "news_bulletin": 0,
        "debt_collection": 0,
        "power_bill": 0,
        "futures_settlement": 0,
        "patent_auction": 0,
        "draw_building": 0,
        "draw_building_redraw": 0,
        "pwr_adjust": 0,
    }
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            condition = (row.get("Condition") or "").strip()
            if not _condition_matches(condition, num_players):
                continue
            event = row["Event"].strip()
            count = int(row["Count"].strip())
            redraw = (row.get("Redraw") or "").strip().lower() == "true"
            if event == "draw_building_card":
                if redraw:
                    counts["draw_building_redraw"] += count
                else:
                    counts["draw_building"] += count
            else:
                counts[event] = counts.get(event, 0) + count
    return counts


def parse_game_config(path: Path) -> dict[str, str]:
    """Parse GameConfig.csv into a {parameter: value} dict.

    All values are returned as strings; the caller is responsible for
    type coercion (int, float, list, etc.).
    """
    config: dict[str, str] = {}
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            config[row["Parameter"].strip()] = row["Value"].strip()
    return config

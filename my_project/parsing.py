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
    The CSV columns are: Name, Rates, Effect.
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
                    rates=parse_resource_list(row["Rates"]),
                    effect=row["Effect"].strip(),
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

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class Resource(StrEnum):
    PWR = "PWR"
    H2O = "H2O"
    FE = "FE"
    C = "C"
    SI = "SI"
    O2 = "O2"
    FOOD = "FOOD"
    GLS = "GLS"
    ELX = "ELX"


# ---------------------------------------------------------------------------
# GameLog — observable mutation log
# ---------------------------------------------------------------------------

@dataclass
class Mutation:
    field: str       # e.g. "player.0.money", "market.FE", "pool"
    old_value: Any
    new_value: Any


@dataclass
class ActionEntry:
    action_id: int
    type: str        # "build", "sell", "swap", "event:power_bill", "free:oc"
    player_name: str
    player_idx: int
    summary: str
    mutations: list[Mutation] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


class GameLog:
    """Central log that records every state mutation grouped by action."""

    def __init__(self, *, enabled: bool = True) -> None:
        self.entries: list[ActionEntry] = []
        self._current: ActionEntry | None = None
        self._next_id: int = 0
        self.enabled: bool = enabled

    def begin(self, type: str, player_name: str, player_idx: int, summary: str) -> None:
        if not self.enabled:
            return
        entry = ActionEntry(
            action_id=self._next_id,
            type=type,
            player_name=player_name,
            player_idx=player_idx,
            summary=summary,
        )
        self._next_id += 1
        self._current = entry

    def record(self, field: str, old_value: Any, new_value: Any) -> None:
        if not self.enabled:
            return
        mutation = Mutation(field=field, old_value=old_value, new_value=new_value)
        if self._current is not None:
            self._current.mutations.append(mutation)
        else:
            # Mutation outside an explicit begin/end — store as standalone entry
            standalone = ActionEntry(
                action_id=self._next_id,
                type="unscoped",
                player_name="",
                player_idx=-1,
                summary="",
                mutations=[mutation],
            )
            self._next_id += 1
            self.entries.append(standalone)

    def annotate(self, key: str, value: Any) -> None:
        """Attach metadata to the current action entry (decisions, context)."""
        if not self.enabled or self._current is None:
            return
        self._current.metadata[key] = value

    def end(self) -> None:
        if not self.enabled:
            return
        if self._current is not None:
            self.entries.append(self._current)
            self._current = None


# ---------------------------------------------------------------------------
# Currency — observable int wrapper for money / debt / credit
# ---------------------------------------------------------------------------

class Currency:
    """Observable int that logs mutations to a GameLog."""

    __slots__ = ("_value", "_log", "_label")

    def __init__(self, value: int, log: GameLog, label: str) -> None:
        self._value = value
        self._log = log
        self._label = label

    def set(self, value: int) -> None:
        old = self._value
        self._value = value
        if old != value:
            self._log.record(self._label, old, value)

    def add(self, amount: int) -> None:
        self.set(self._value + amount)

    @property
    def value(self) -> int:
        return self._value

    def __repr__(self) -> str:
        return f"Currency({self._value}, label={self._label!r})"


# ---------------------------------------------------------------------------
# ResourceRates — observable dict for player production rates
# ---------------------------------------------------------------------------

class ResourceRates:
    """Observable dict[Resource, int] that logs mutations to a GameLog."""

    __slots__ = ("_values", "_log", "_label")

    def __init__(self, values: dict[Resource, int], log: GameLog, label: str) -> None:
        self._values = dict(values)
        self._log = log
        self._label = label

    # --- dict-like read interface ---

    def get(self, resource: Resource, default: int = 0) -> int:
        return self._values.get(resource, default)

    def items(self):
        return self._values.items()

    def values(self):
        return self._values.values()

    def keys(self):
        return self._values.keys()

    def __getitem__(self, resource: Resource) -> int:
        return self._values[resource]

    def __contains__(self, resource: Resource) -> bool:
        return resource in self._values

    def __iter__(self):
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)

    # --- dict-like write interface (logged) ---

    def __setitem__(self, resource: Resource, value: int) -> None:
        old = self._values.get(resource, 0)
        self._values[resource] = value
        if old != value:
            self._log.record(f"{self._label}.{resource.value}", old, value)

    def adjust(self, resource: Resource, delta: int) -> None:
        self[resource] = self.get(resource, 0) + delta

    def __repr__(self) -> str:
        return f"ResourceRates({dict(self._values)}, label={self._label!r})"


# ---------------------------------------------------------------------------
# CardZone — observable list for hand, pool, buildings_played
# ---------------------------------------------------------------------------

class CardZone:
    """Observable list[Card] that logs mutations to a GameLog."""

    __slots__ = ("_cards", "_log", "_label")

    def __init__(self, cards: list[Card], log: GameLog, label: str) -> None:
        self._cards: list[Card] = list(cards)
        self._log = log
        self._label = label

    # --- read interface ---

    def __getitem__(self, index: int | slice) -> Any:
        return self._cards[index]

    def __len__(self) -> int:
        return len(self._cards)

    def __iter__(self):
        return iter(self._cards)

    def __contains__(self, item: Any) -> bool:
        return item in self._cards

    def __bool__(self) -> bool:
        return bool(self._cards)

    def __add__(self, other: list) -> list:
        return self._cards + other

    def __radd__(self, other: list) -> list:
        return other + self._cards

    # --- write interface (logged) ---

    @staticmethod
    def _card_desc(card: Card) -> dict:
        """Compact card descriptor for log entries."""
        d: dict[str, Any] = {"name": card.building}
        if card.can_sell:
            d["sells"] = [r.value for r in card.can_sell]
        elif card.can_fulfill_contract:
            d["action"] = "contract"
        return d

    def append(self, card: Card) -> None:
        idx = len(self._cards)
        self._cards.append(card)
        self._log.record(self._label, "append", {"idx": idx, **self._card_desc(card)})

    def extend(self, cards: list[Card]) -> None:
        start = len(self._cards)
        self._cards.extend(cards)
        if cards:
            self._log.record(self._label, "extend", [
                {"idx": start + i, **self._card_desc(c)} for i, c in enumerate(cards)
            ])

    def pop(self, index: int = -1) -> Card:
        resolved = index if index >= 0 else len(self._cards) + index
        card = self._cards.pop(index)
        self._log.record(self._label, "pop", {"idx": resolved, **self._card_desc(card)})
        return card

    def clear(self) -> None:
        old_len = len(self._cards)
        self._cards.clear()
        if old_len:
            self._log.record(self._label, "clear", old_len)

    def __setitem__(self, index: int, card: Card) -> None:
        old = self._cards[index]
        self._cards[index] = card
        self._log.record(self._label, f"swap[{index}]", {
            "old": self._card_desc(old), "new": self._card_desc(card),
        })

    def replace(self, cards: list[Card]) -> None:
        """Replace entire contents (for `player.hand = [...]` assignments)."""
        old_len = len(self._cards)
        self._cards = list(cards)
        self._log.record(self._label, "replace", {
            "old_len": old_len,
            "cards": [self._card_desc(c) for c in self._cards],
        })

    def __repr__(self) -> str:
        names = [c.building for c in self._cards]
        return f"CardZone({names}, label={self._label!r})"


RESOURCE_COLORS = {
    Resource.PWR: "#e74c3c",
    Resource.H2O: "#2c3e80",
    Resource.FE: "#2c2c2c",
    Resource.C: "#8e44ad",
    Resource.SI: "#f1c40f",
    Resource.O2: "#ecf0f1",
    Resource.FOOD: "#27ae60",
    Resource.GLS: "#5dade2",
    Resource.ELX: "#e67e22",
}

RESOURCE_TIERS = {
    Resource.PWR: 0,
    Resource.FE: 1,
    Resource.C: 1,
    Resource.SI: 1,
    Resource.H2O: 2,
    Resource.O2: 2,
    Resource.FOOD: 2,
    Resource.GLS: 2,
    Resource.ELX: 2,
}


@dataclass(frozen=True)
class ResourceAmount:
    resource: Resource
    amount: int


@dataclass
class Card:
    alternate: str
    slot: int
    building: str
    costs: list[ResourceAmount]
    rates: list[ResourceAmount]
    effect: str
    can_sell: list[Resource]
    can_fulfill_contract: bool

    @property
    def consumed_resources(self) -> list[ResourceAmount]:
        """Cost resources + negative rate resources."""
        result = [ResourceAmount(ra.resource, ra.amount) for ra in self.costs]
        for ra in self.rates:
            if ra.amount < 0:
                result.append(ra)
        return result

    @property
    def produced_resources(self) -> list[ResourceAmount]:
        """Positive rate resources."""
        return [ra for ra in self.rates if ra.amount > 0]


@dataclass
class Contract:
    requirements: list[ResourceAmount]
    reward: int
    count: int


@dataclass
class MarketTrack:
    resource: Resource
    prices: list[int]

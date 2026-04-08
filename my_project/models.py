from dataclasses import dataclass, field
from enum import StrEnum


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

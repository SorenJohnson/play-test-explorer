"""Tests for the silent patent auction system."""

from pathlib import Path

from my_project.models import Card, Resource, ResourceAmount
from my_project.parsing import parse_cards, parse_contracts, parse_patents
from my_project.simulation import (
    EventCard,
    EventType,
    GameState,
    _default_ai_bid,
    do_patent_auction,
    execute_event,
    settle_silent_auction,
)


DATA = Path(__file__).resolve().parent.parent / "my_project" / "data"


def _load():
    return parse_cards(DATA / "Cards.csv"), parse_contracts(DATA / "Contracts.csv")


def _patent(name: str, rates: list[tuple[Resource, int]] | None = None) -> Card:
    return Card(
        alternate="Patent",
        slot=5,
        building=name,
        costs=[],
        rates=[ResourceAmount(resource=r, amount=a) for r, a in (rates or [])],
        effect="",
        can_sell=[],
        can_fulfill_contract=False,
    )


# --- parse_patents ---


class TestParsePatents:
    def test_patents_csv_parses(self):
        patents = parse_patents(DATA / "Patents.csv")
        assert len(patents) > 0
        for p in patents:
            assert p.alternate == "Patent"
            assert p.slot == 5
            assert p.building  # has a name
            assert p.costs == []  # patents are awarded, not built


# --- settle_silent_auction ---


class TestSettleSilentAuction:
    def test_no_bids_returns_none(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test")
        result = settle_silent_auction(state, patent, bids={0: 0, 1: 0, 2: 0})
        assert result is None

    def test_highest_bidder_wins(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test")
        result = settle_silent_auction(state, patent, bids={0: 5, 1: 20, 2: 10})
        assert result is not None
        winner_idx, amount = result
        assert winner_idx == 1
        # Pays runner_up + 5 = 10 + 5 = 15
        assert amount == 15

    def test_ties_broken_by_turn_order(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test")
        result = settle_silent_auction(state, patent, bids={0: 20, 1: 20, 2: 5})
        winner_idx, amount = result
        assert winner_idx == 0  # earlier seat wins ties
        # Tied bids are still the runner-up: 20 + 5 = 25
        assert amount == 25

    def test_only_one_bidder_pays_5(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test")
        result = settle_silent_auction(state, patent, bids={0: 25, 1: 0, 2: 0})
        winner_idx, amount = result
        assert winner_idx == 0
        assert amount == 5  # runner_up = 0, so pays 0 + 5 = 5

    def test_winner_takes_patent_and_rates(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test", rates=[(Resource.PWR, 1), (Resource.FE, 2)])
        rate_pwr_before = state.players[1].rate(Resource.PWR)
        rate_fe_before = state.players[1].rate(Resource.FE)
        settle_silent_auction(state, patent, bids={0: 10, 1: 20})
        assert patent in state.players[1].buildings_played
        assert state.players[1].rate(Resource.PWR) == rate_pwr_before + 1
        assert state.players[1].rate(Resource.FE) == rate_fe_before + 2

    def test_winner_pays_debt_not_cash(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test")
        money_before = state.players[1].money
        debt_before = state.players[1].debt
        settle_silent_auction(state, patent, bids={0: 10, 1: 20})
        assert state.players[1].money == money_before  # cash unchanged
        assert state.players[1].debt == debt_before + 15  # debt grows by 10+5


# --- do_patent_auction ---


class TestDoPatentAuction:
    def test_empty_pile_is_noop(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        # patent_pile defaults to empty
        detail = do_patent_auction(state)
        assert "no patents" in detail.lower()

    def test_runs_silent_auction_with_ai_bids(self):
        cards, contracts = _load()
        patents = [_patent("AlphaPatent", rates=[(Resource.PWR, 1)])]
        state = GameState.create(cards, contracts, num_players=3, patent_pile=patents)
        # With default cash, every player should bid the same heuristic amount,
        # and ties go to seat 0.
        detail = do_patent_auction(state)
        assert "AlphaPatent" in detail
        # The patent should now be in some player's buildings_played
        winners = [
            i for i, p in enumerate(state.players)
            if any(c.building == "AlphaPatent" for c in p.buildings_played)
        ]
        assert len(winners) == 1

    def test_pending_bids_override_ai(self):
        """Setting state.pending_bids forces specific bid amounts."""
        cards, contracts = _load()
        patents = [_patent("BetaPatent")]
        state = GameState.create(cards, contracts, num_players=3, patent_pile=patents)
        state.pending_bids = {0: 0, 1: 50, 2: 0}  # P1 bids high, others pass
        detail = do_patent_auction(state)
        assert any(c.building == "BetaPatent" for c in state.players[1].buildings_played)
        # Pending bids should be cleared after consumption
        assert state.pending_bids == {}

    def test_pile_advances_per_auction(self):
        """Each auction consumes one patent from the top of the pile."""
        cards, contracts = _load()
        patents = [_patent("First"), _patent("Second"), _patent("Third")]
        state = GameState.create(cards, contracts, num_players=3, patent_pile=patents)
        detail1 = do_patent_auction(state)
        detail2 = do_patent_auction(state)
        # The exact patent that wins depends on shuffle order at create time,
        # but each auction should consume distinct patents.
        assert state.patent_idx == 2


# --- _default_ai_bid heuristic ---


class TestDefaultAiBid:
    def test_no_cash_no_bid(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].money = 0
        state.players[0].debt = 0
        bid = _default_ai_bid(state.players[0], _patent("X"))
        assert bid == 0

    def test_negative_net_no_bid(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].money = 5
        state.players[0].debt = 20
        bid = _default_ai_bid(state.players[0], _patent("X"))
        assert bid == 0

    def test_bid_in_5_increments(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].money = 100
        state.players[0].debt = 0
        bid = _default_ai_bid(state.players[0], _patent("X"))
        assert bid % 5 == 0

    def test_bid_capped_at_30(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].money = 1000
        state.players[0].debt = 0
        bid = _default_ai_bid(state.players[0], _patent("X"))
        assert bid <= 30

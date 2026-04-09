"""Tests for EventDeckConfig, custom event decks, and the NEWS event type."""

from my_project.models import Resource
from my_project.simulation import (
    EventCard,
    EventDeckConfig,
    EventType,
    GameState,
    Market,
    Player,
    _ec,
    build_event_deck,
    do_news,
    execute_event,
)
from my_project.parsing import parse_cards, parse_contracts
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "my_project" / "data"


def _load():
    return parse_cards(DATA / "Cards.csv"), parse_contracts(DATA / "Contracts.csv")


def _count(deck, et):
    return sum(1 for ec in deck if ec.type == et)


# --- EventDeckConfig ---


class TestEventDeckConfig:
    def test_default_config_matches_old_behavior(self):
        """Default EventDeckConfig should produce the same ranges as the old hardcoded constants."""
        deck = build_event_deck(8, 3, EventDeckConfig())
        assert len(deck) == 24
        assert 3 <= _count(deck, EventType.POWER_BILL) <= 4
        assert 2 <= _count(deck, EventType.DEBT_COLLECTION) <= 4
        assert 3 <= _count(deck, EventType.FUTURES_SETTLEMENT) <= 4
        assert _count(deck, EventType.END_GAME) == 1
        assert _count(deck, EventType.NEWS) == 0

    def test_fixed_counts(self):
        """Fixed int counts produce exact event counts."""
        cfg = EventDeckConfig(
            power_bill_count=5,
            debt_collection_count=2,
            futures_settlement_count=3,
        )
        deck = build_event_deck(8, 3, cfg)
        assert _count(deck, EventType.POWER_BILL) == 5
        assert _count(deck, EventType.DEBT_COLLECTION) == 2
        assert _count(deck, EventType.FUTURES_SETTLEMENT) == 3

    def test_news_events_inserted(self):
        """When news_pool is provided and news_count > 0, news events appear in the deck."""
        news = EventCard(type=EventType.NEWS, label="FOOD spike", payload={"market_deltas": {"FOOD": 3}})
        cfg = EventDeckConfig(
            news_pool=[news],
            news_count=2,
        )
        deck = build_event_deck(8, 3, cfg)
        assert _count(deck, EventType.NEWS) == 2

    def test_news_count_zero_by_default(self):
        """Default config produces no news events even with a non-empty pool."""
        news = EventCard(type=EventType.NEWS, label="test", payload={"market_deltas": {"FE": 1}})
        cfg = EventDeckConfig(news_pool=[news])  # news_count defaults to 0
        deck = build_event_deck(8, 3, cfg)
        assert _count(deck, EventType.NEWS) == 0

    def test_no_config_preserves_old_behavior(self):
        """Passing config=None should work identically to the old function signature."""
        deck = build_event_deck(8, 3, None)
        assert len(deck) == 24
        assert 3 <= _count(deck, EventType.POWER_BILL) <= 4


# --- Custom event deck override ---


class TestCustomEventDeck:
    def test_explicit_deck_overrides_config(self):
        """GameState.create with an explicit event_deck ignores build_event_deck entirely."""
        cards, contracts = _load()
        custom = [_ec(EventType.POWER_BILL)] * 5 + [_ec(EventType.END_GAME)]
        state = GameState.create(cards, contracts, event_deck=custom)
        assert len(state.event_deck) == 6
        assert _count(state.event_deck, EventType.POWER_BILL) == 5
        assert _count(state.event_deck, EventType.END_GAME) == 1

    def test_explicit_deck_with_news(self):
        """Custom deck can contain NEWS events."""
        cards, contracts = _load()
        news = EventCard(type=EventType.NEWS, label="H2O crisis", payload={"market_deltas": {"H2O": 5}})
        custom = [news, _ec(EventType.END_GAME)]
        state = GameState.create(cards, contracts, event_deck=custom)
        assert _count(state.event_deck, EventType.NEWS) == 1


# --- NEWS event execution ---


class TestNewsEvent:
    def test_news_moves_market(self):
        """A news event with market_deltas adjusts the market price."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts)
        player = state.players[0]
        price_before = state.market.price(Resource.FOOD)
        news = EventCard(type=EventType.NEWS, label="FOOD shortage", payload={"market_deltas": {"FOOD": 4}})
        detail = execute_event(state, news, player)
        price_after = state.market.price(Resource.FOOD)
        assert price_after > price_before
        assert "NEWS" in detail
        assert "FOOD" in detail

    def test_news_multiple_resources(self):
        """A news event can move multiple resources at once."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts)
        player = state.players[0]
        food_before = state.market.price(Resource.FOOD)
        h2o_before = state.market.price(Resource.H2O)
        news = EventCard(
            type=EventType.NEWS,
            label="Supply shock",
            payload={"market_deltas": {"FOOD": 3, "H2O": -2}},
        )
        execute_event(state, news, player)
        assert state.market.price(Resource.FOOD) > food_before
        assert state.market.price(Resource.H2O) < h2o_before

    def test_news_no_payload_is_noop(self):
        """A news event with empty/missing payload is harmless."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts)
        player = state.players[0]
        prices_before = {r: state.market.price(r) for r in Resource}
        news = EventCard(type=EventType.NEWS, label="Nothing happened")
        detail = execute_event(state, news, player)
        prices_after = {r: state.market.price(r) for r in Resource}
        assert prices_before == prices_after
        assert "NEWS" in detail

    def test_news_display_label(self):
        """The detail string includes the event's custom label."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts)
        player = state.players[0]
        news = EventCard(type=EventType.NEWS, label="Iron Rush", payload={"market_deltas": {"FE": 2}})
        detail = execute_event(state, news, player)
        assert "Iron Rush" in detail

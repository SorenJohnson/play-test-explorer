from pathlib import Path

from my_project.models import Resource, ResourceAmount, Card
from my_project.parsing import parse_cards, parse_contracts
from my_project.simulation import (
    EventType,
    GameState,
    Market,
    Player,
    PRICE_TRACK,
    build_event_deck,
    compute_build_deficit,
    do_pwr_adjust,
    execute_build,
    run_game,
)
from my_project.strategies import greedy_strategy, random_strategy

DATA_DIR = Path(__file__).resolve().parent.parent / "my_project" / "data"


def _load_data():
    return parse_cards(DATA_DIR / "Cards.csv"), parse_contracts(DATA_DIR / "Contracts.csv")


class TestMarket:
    def test_initial_price(self):
        m = Market.create(start_position=4)
        assert m.price(Resource.FE) == PRICE_TRACK[4]

    def test_buy_increases_price(self):
        m = Market.create(start_position=4)
        price_before = m.price(Resource.FE)
        m.buy(Resource.FE, 1)
        assert m.price(Resource.FE) >= price_before

    def test_sell_decreases_price(self):
        m = Market.create(start_position=8)
        price_before = m.price(Resource.FE)
        m.sell(Resource.FE, 1)
        assert m.price(Resource.FE) <= price_before

    def test_buy_returns_total_cost(self):
        m = Market.create(start_position=4)
        cost = m.buy(Resource.FE, 2)
        assert cost > 0

    def test_position_clamped(self):
        m = Market.create(start_position=0)
        m.sell(Resource.FE, 5)
        assert m.positions[Resource.FE] == 0

        m2 = Market.create(start_position=len(PRICE_TRACK) - 1)
        m2.buy(Resource.FE, 5)
        assert m2.positions[Resource.FE] == len(PRICE_TRACK) - 1

    def test_estimate_buy_cost_matches(self):
        m = Market.create(start_position=4)
        estimate = m.estimate_buy_cost(Resource.FE, 3)
        actual = m.buy(Resource.FE, 3)
        assert estimate == actual


class TestEventDeck:
    def test_deck_size(self):
        deck = build_event_deck(15, 3)
        assert len(deck) == 45

    def test_deck_composition(self):
        deck = build_event_deck(8, 3)
        assert 3 <= deck.count(EventType.POWER_BILL) <= 4
        assert 2 <= deck.count(EventType.DEBT_COLLECTION) <= 4
        assert 3 <= deck.count(EventType.FUTURES_SETTLEMENT) <= 4

    def test_small_deck_truncates(self):
        deck = build_event_deck(2, 1)  # only 2 slots
        assert len(deck) == 2


class TestPwrAdjust:
    def test_positive_pwr_lowers_price(self):
        cards, contracts = _load_data()
        state = GameState.create(cards, contracts)
        player = state.players[0]
        player.rates[Resource.PWR] = 5
        price_before = state.market.price(Resource.PWR)
        do_pwr_adjust(state, player)
        assert state.market.price(Resource.PWR) <= price_before

    def test_negative_pwr_raises_price(self):
        cards, contracts = _load_data()
        state = GameState.create(cards, contracts)
        player = state.players[0]
        player.rates[Resource.PWR] = -3
        price_before = state.market.price(Resource.PWR)
        do_pwr_adjust(state, player)
        assert state.market.price(Resource.PWR) >= price_before


class TestSpecialCardFilter:
    def test_no_special_effect_cards_in_deck(self):
        cards, contracts = _load_data()
        state = GameState.create(cards, contracts)
        all_deck_cards = state.deck.cards + state.deck.discard
        for card in state.pool:
            all_deck_cards.append(card)
        for player in state.players:
            all_deck_cards.extend(player.hand)
        for card in all_deck_cards:
            assert card.effect == "", f"Card {card.building} has effect: {card.effect}"


class TestBuildDeficit:
    def test_no_deficit_when_rate_covers(self):
        player = Player(name="test", money=100)
        player.rates[Resource.FE] = 3
        market = Market.create(4)
        card = Card(
            alternate="C/SI", slot=1, building="Test",
            costs=[ResourceAmount(Resource.FE, 2)],
            rates=[ResourceAmount(Resource.PWR, 2)],
            effect="", can_sell=[], can_fulfill_contract=False,
        )
        result = compute_build_deficit([card], player, 0, market)
        assert result is not None
        deficit, cost = result
        assert len(deficit) == 0
        assert cost == 0

    def test_deficit_when_rate_short(self):
        player = Player(name="test", money=100)
        player.rates[Resource.FE] = 1
        market = Market.create(4)
        card = Card(
            alternate="C/SI", slot=1, building="Test",
            costs=[ResourceAmount(Resource.FE, 3)],
            rates=[ResourceAmount(Resource.PWR, 2)],
            effect="", can_sell=[], can_fulfill_contract=False,
        )
        result = compute_build_deficit([card], player, 0, market)
        assert result is not None
        deficit, cost = result
        assert deficit[Resource.FE] == 2
        assert cost > 0

    def test_multi_card_totals_costs(self):
        """Two cards each costing 2 FE with +2 FE rate = 2 deficit (rate offsets once)."""
        player = Player(name="test", money=100)
        player.rates[Resource.FE] = 2
        market = Market.create(4)
        card = Card(
            alternate="C/SI", slot=1, building="Test",
            costs=[ResourceAmount(Resource.FE, 2)],
            rates=[], effect="", can_sell=[], can_fulfill_contract=False,
        )
        result = compute_build_deficit([card, card], player, 0, market)
        assert result is not None
        deficit, _ = result
        assert deficit[Resource.FE] == 2  # 4 total - 2 rate = 2

    def test_discard_reduces_deficit(self):
        player = Player(name="test", money=100)
        player.rates[Resource.FE] = 0
        market = Market.create(4)
        card = Card(
            alternate="C/SI", slot=1, building="Test",
            costs=[ResourceAmount(Resource.FE, 3)],
            rates=[], effect="", can_sell=[], can_fulfill_contract=False,
        )
        result_no_disc = compute_build_deficit([card], player, 0, market)
        result_with_disc = compute_build_deficit([card], player, 2, market)
        assert result_no_disc is not None and result_with_disc is not None
        assert result_with_disc[1] < result_no_disc[1]

    def test_unaffordable_returns_none(self):
        player = Player(name="test", money=0)
        market = Market.create(4)
        card = Card(
            alternate="C/SI", slot=1, building="Test",
            costs=[ResourceAmount(Resource.FE, 5)],
            rates=[], effect="", can_sell=[], can_fulfill_contract=False,
        )
        result = compute_build_deficit([card], player, 0, market)
        assert result is None


class TestNoBuildDebt:
    def test_cannot_build_without_money(self):
        cards, contracts = _load_data()
        state = GameState.create(cards, contracts, start_money=0)
        player = state.players[0]
        # Find a card with costs
        costly_cards = [i for i, c in enumerate(player.hand) if c.costs]
        if costly_cards:
            result = execute_build(state, player, [costly_cards[0]], [])
            # Should fail (return None) since player has $0
            assert result is None or player.debt == 0


class TestFixedTurns:
    def test_all_players_same_turns(self):
        cards, contracts = _load_data()
        state = run_game(cards, contracts, greedy_strategy, num_players=3, max_turns=10)
        # Each player should have entries in history
        player_turns = {}
        for rec in state.history:
            player_turns[rec.player] = player_turns.get(rec.player, 0) + 1
        counts = list(player_turns.values())
        assert len(set(counts)) == 1  # all equal


class TestRunGame:
    def test_greedy_completes(self):
        cards, contracts = _load_data()
        state = run_game(cards, contracts, greedy_strategy, max_turns=10)
        assert state.turn > 0
        assert len(state.history) > 0

    def test_random_completes(self):
        cards, contracts = _load_data()
        state = run_game(cards, contracts, random_strategy, max_turns=10)
        assert state.turn > 0

    def test_greedy_earns_more_than_random(self):
        cards, contracts = _load_data()
        greedy_worths = []
        random_worths = []
        for _ in range(20):
            g = run_game(cards, contracts, greedy_strategy, max_turns=15, randomize_market=True)
            greedy_worths.append(g.players[0].net_worth())
            r = run_game(cards, contracts, random_strategy, max_turns=15, randomize_market=True)
            random_worths.append(r.players[0].net_worth())
        assert sum(greedy_worths) / len(greedy_worths) > sum(random_worths) / len(random_worths)

    def test_multi_player_game(self):
        cards, contracts = _load_data()
        state = run_game(cards, contracts, greedy_strategy, num_players=3, max_turns=10)
        assert len(state.players) == 3

    def test_events_recorded(self):
        cards, contracts = _load_data()
        state = run_game(cards, contracts, greedy_strategy, max_turns=10)
        events = [rec.event for rec in state.history]
        assert len(events) > 0
        # At least some non-empty events
        assert any(e != "no event" for e in events)

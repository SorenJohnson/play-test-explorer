from pathlib import Path

from my_project.models import Resource, ResourceAmount, Card
from my_project.parsing import parse_cards, parse_contracts
from my_project.simulation import (
    EventType,
    GameState,
    Market,
    Player,
    PRICE_TRACK,
    _apply_debt,
    build_event_deck,
    compute_build_deficit,
    do_debt_collection,
    do_power_bill,
    do_pwr_adjust,
    execute_build,
    execute_contract,
    run_game,
)
from my_project.models import Contract
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
    def test_deck_has_terminal_sentinels(self):
        """A 2-round deck has 1 END_ROUND and 1 END_GAME sentinel."""
        deck = build_event_deck(3, num_rounds=2)
        end_round = sum(1 for e in deck if e.type == EventType.END_ROUND)
        end_game = sum(1 for e in deck if e.type == EventType.END_GAME)
        assert end_round == 1
        assert end_game == 1

    def test_3p_turns_are_balanced(self):
        """At 3P with 2 rounds, players get roughly equal turns.
        The exact count depends on Events.csv composition; the max
        difference between any two players should be at most 1."""
        from my_project.strategies import smart_greedy_strategy
        cards, contracts = _load_data()
        state = run_game(cards, contracts, strategy=smart_greedy_strategy,
                         num_players=3, randomize_market=True, num_rounds=2)
        player_turns = {}
        for rec in state.history:
            player_turns[rec.player] = player_turns.get(rec.player, 0) + 1
        counts = list(player_turns.values())
        assert max(counts) - min(counts) <= 1, f"Turn imbalance > 1: {counts}"

    def test_patent_auctions_only_in_round_1(self):
        """Patent auction cards are removed after round 1."""
        deck = build_event_deck(3, num_rounds=2)
        # Find the END_ROUND sentinel — everything after it is round 2
        end_round_idx = next(i for i, e in enumerate(deck) if e.type == EventType.END_ROUND)
        round2 = deck[end_round_idx + 1:]
        patents_in_r2 = sum(1 for e in round2 if e.type == EventType.PATENT_AUCTION)
        assert patents_in_r2 == 0, f"Expected 0 patent auctions in round 2, got {patents_in_r2}"

    def test_round_2_converts_patents_to_draws(self):
        """Round 2 converts patent auctions to draw_building_card events."""
        deck = build_event_deck(3, num_rounds=2)
        end_round_idx = next(i for i, e in enumerate(deck) if e.type == EventType.END_ROUND)
        r1 = deck[:end_round_idx]
        r2 = deck[end_round_idx + 1:-1]  # exclude END_GAME
        # Round 1 has patent auctions; round 2 should have none
        r1_patents = sum(1 for e in r1 if e.type == EventType.PATENT_AUCTION)
        r2_patents = sum(1 for e in r2 if e.type == EventType.PATENT_AUCTION)
        assert r1_patents > 0
        assert r2_patents == 0
        # Round 2 should have more draw_building_card events (converted patents)
        r2_draws = sum(1 for e in r2 if e.type == EventType.DRAW_BUILDING_CARD)
        r1_draws = sum(1 for e in r1 if e.type == EventType.DRAW_BUILDING_CARD)
        assert r2_draws > r1_draws

    def test_single_round_has_end_game_only(self):
        """A 1-round deck has END_GAME but no END_ROUND."""
        deck = build_event_deck(3, num_rounds=1)
        assert sum(1 for e in deck if e.type == EventType.END_ROUND) == 0
        assert sum(1 for e in deck if e.type == EventType.END_GAME) == 1


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
        result = compute_build_deficit([card], player, market)
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
        result = compute_build_deficit([card], player, market)
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
        result = compute_build_deficit([card, card], player, market)
        assert result is not None
        deficit, _ = result
        assert deficit[Resource.FE] == 2  # 4 total - 2 rate = 2

    def test_unaffordable_returns_none(self):
        player = Player(name="test", money=0)
        market = Market.create(4)
        card = Card(
            alternate="C/SI", slot=1, building="Test",
            costs=[ResourceAmount(Resource.FE, 5)],
            rates=[], effect="", can_sell=[], can_fulfill_contract=False,
        )
        result = compute_build_deficit([card], player, market)
        assert result is None


class TestNoBuildDebt:
    def test_cannot_build_without_money(self):
        cards, contracts = _load_data()
        state = GameState.create(cards, contracts, start_money=0)
        player = state.players[0]
        # Find a card with costs
        costly_cards = [i for i, c in enumerate(player.hand) if c.costs]
        if costly_cards:
            result = execute_build(state, player, [costly_cards[0]])
            # Should fail (return None) since player has $0
            assert result is None or player.debt == 0


class TestFixedTurns:
    def test_all_players_roughly_same_turns(self):
        """Each player should get roughly the same number of turns.
        With deck-driven game length, redraws can cause the last player(s)
        to get one fewer turn — that's acceptable (max diff of 1)."""
        cards, contracts = _load_data()
        state = run_game(cards, contracts, greedy_strategy, num_players=3, max_turns=10)
        player_turns = {}
        for rec in state.history:
            player_turns[rec.player] = player_turns.get(rec.player, 0) + 1
        counts = list(player_turns.values())
        assert max(counts) - min(counts) <= 1


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


# --- Credit / contract debt absorption ---


class TestApplyDebt:
    def test_no_credit_adds_to_debt(self):
        p = Player(name="P", debt=0, credit=0)
        consumed, real = _apply_debt(p, 50)
        assert consumed == 0
        assert real == 50
        assert p.debt == 50
        assert p.credit == 0

    def test_credit_absorbs_full_debt(self):
        p = Player(name="P", debt=0, credit=100)
        consumed, real = _apply_debt(p, 50)
        assert consumed == 50
        assert real == 0
        assert p.debt == 0
        assert p.credit == 50  # 100 - 50

    def test_credit_partially_absorbs_debt(self):
        p = Player(name="P", debt=0, credit=20)
        consumed, real = _apply_debt(p, 50)
        assert consumed == 20
        assert real == 30
        assert p.debt == 30
        assert p.credit == 0

    def test_zero_amount_is_noop(self):
        p = Player(name="P", debt=0, credit=10)
        consumed, real = _apply_debt(p, 0)
        assert consumed == 0 and real == 0
        assert p.credit == 10


class TestContractCreditModel:
    """The user-facing example: $0 cash, -$50 debt + $50 contract = $0 NW.
    Plus credit semantics for leftover reward."""

    def _setup(self):
        cards, contracts = _load_data()
        state = GameState.create(cards, contracts, num_players=3)
        # Give player 0 a known clean state
        p = state.players[0]
        p.money = 0
        p.debt = 0
        p.credit = 0
        for r in Resource:
            p.rates[r] = 5  # plenty of every resource
        return state, p

    def _put_contract(self, state, requirements, reward=50):
        contract = Contract(requirements=requirements, reward=reward, count=1)
        state.available_contracts[0] = contract
        return contract

    def _give_contract_card(self, p):
        from my_project.models import Card as _Card
        p.hand = [_Card(
            alternate="Contract", slot=1, building="MockContract",
            costs=[], rates=[], effect="",
            can_sell=[], can_fulfill_contract=True,
        )]

    def test_user_example_50_debt_paid_off_zero_nw(self):
        """$0 cash, $50 debt + $50 contract → $0 NW, $0 debt."""
        state, p = self._setup()
        p.debt = 50
        self._put_contract(state, [ResourceAmount(Resource.FE, 1)], reward=50)
        self._give_contract_card(p)
        execute_contract(state, p, card_idx=0, contract_idx=0)
        assert p.debt == 0
        assert p.credit == 0
        assert p.money == 0
        assert p.net_worth() == 0

    def test_no_debt_full_reward_becomes_credit(self):
        """$0 cash, $0 debt + $50 contract → $0 cash, $0 debt, $50 credit, NW $50."""
        state, p = self._setup()
        self._put_contract(state, [ResourceAmount(Resource.FE, 1)], reward=50)
        self._give_contract_card(p)
        execute_contract(state, p, card_idx=0, contract_idx=0)
        assert p.debt == 0
        assert p.credit == 50
        assert p.money == 0
        assert p.net_worth() == 50

    def test_partial_debt_paid_remainder_credit(self):
        """$0 cash, $20 debt + $50 contract → $0 debt, $30 credit, NW $30."""
        state, p = self._setup()
        p.debt = 20
        self._put_contract(state, [ResourceAmount(Resource.FE, 1)], reward=50)
        self._give_contract_card(p)
        execute_contract(state, p, card_idx=0, contract_idx=0)
        assert p.debt == 0
        assert p.credit == 30
        assert p.net_worth() == 30

    def test_credit_absorbs_future_debt_from_power_bill(self):
        """A player with credit takes a power bill hit; credit absorbs first."""
        cards, contracts = _load_data()
        state = GameState.create(cards, contracts, num_players=3)
        p = state.players[0]
        p.money = 0
        p.debt = 0
        p.credit = 30
        # Force a -3 PWR rate so the bill costs PWR price * 3
        p.rates[Resource.PWR] = -3
        pwr_price = state.market.price(Resource.PWR)
        do_power_bill(state)
        cost = pwr_price * 3
        # Credit should absorb up to the cost; debt only takes the overflow
        if cost <= 30:
            assert p.debt == 0
            assert p.credit == 30 - cost
        else:
            assert p.debt == cost - 30
            assert p.credit == 0

    def test_contracts_no_longer_double_counted_in_nw(self):
        """contracts_fulfilled is no longer added to NW (it was a bug)."""
        p = Player(name="P", money=0, debt=0, credit=0)
        p.contracts_fulfilled = 5  # absurd but should not affect NW
        assert p.net_worth() == 0


# --- Per-event detail line capture ---


class TestEventLines:
    """`state.last_event_lines` captures structured per-event detail records.

    These tests pin down the headers and per-player rows that the play UI
    surfaces in the expandable event log row.
    """

    def test_power_bill_emits_header_and_per_player_lines(self):
        cards, contracts = _load_data()
        state = GameState.create(cards, contracts, num_players=2)
        # Player 0 sells PWR; player 1 owes PWR
        state.players[0].rates[Resource.PWR] = 3
        state.players[1].rates[Resource.PWR] = -2
        # Reset before invocation since GameState.create may have populated it
        state.last_event_lines = []
        do_power_bill(state)

        # First line is the header
        assert len(state.last_event_lines) >= 1
        assert state.last_event_lines[0]["kind"] == "header"
        assert "Power Bill" in state.last_event_lines[0]["text"]

        # Both players have a per-player row, in seat order
        player_lines = [l for l in state.last_event_lines if l["kind"] == "player"]
        assert len(player_lines) == 2
        assert player_lines[0]["player_idx"] == 0
        assert player_lines[1]["player_idx"] == 1
        # Each per-player row carries an NW snapshot
        for line in player_lines:
            assert "money_after" in line
            assert "debt_after" in line
            assert "credit_after" in line
            assert "net_worth_after" in line
        # The seller earned (text starts with +$); the debtor owes (−$).
        assert player_lines[0]["text"].startswith("+$")
        assert player_lines[1]["text"].startswith("−$")

    def test_debt_collection_emits_lines_only_for_charged_players(self):
        cards, contracts = _load_data()
        state = GameState.create(cards, contracts, num_players=3)
        # Player 0 has debt → gets charged; players 1 and 2 don't
        state.players[0].debt = 100
        state.players[1].debt = 0
        state.players[2].debt = 0
        state.last_event_lines = []
        do_debt_collection(state)

        assert state.last_event_lines[0]["kind"] == "header"
        player_lines = [l for l in state.last_event_lines if l["kind"] == "player"]
        # Only player 0 should appear
        assert len(player_lines) == 1
        assert player_lines[0]["player_idx"] == 0
        assert "interest" in player_lines[0]["text"]

    def test_event_lines_clear_between_events(self):
        """execute_event_with_redraws resets the line list at the top of
        each fresh event chain."""
        from my_project.simulation import (
            execute_event_with_redraws,
            EventCard,
            EventType,
        )
        cards, contracts = _load_data()
        state = GameState.create(cards, contracts, num_players=2)
        state.players[0].rates[Resource.PWR] = 2
        # Stage one event, run it, stage another
        ev1 = EventCard(type=EventType.POWER_BILL)
        execute_event_with_redraws(state, ev1, state.players[0])
        first_count = len(state.last_event_lines)
        assert first_count > 0

        ev2 = EventCard(type=EventType.DEBT_COLLECTION)
        execute_event_with_redraws(state, ev2, state.players[0])
        # The list was reset and now contains only the second event's lines
        # (which is just the header for a player with no debt).
        assert all("Debt" in l["text"] or "interest" in l["text"]
                   for l in state.last_event_lines)
        assert state.last_event_lines[0]["text"] == "Debt Collection"

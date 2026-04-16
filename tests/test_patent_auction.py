"""Tests for the silent patent auction system."""

from pathlib import Path

from my_project.models import Card, Resource, ResourceAmount
from my_project.parsing import parse_cards, parse_contracts, parse_patents
from my_project.play_adapter import PlayableGame
from my_project.simulation import (
    EventCard,
    EventType,
    GameState,
    _default_ai_bid,
    _ec,
    do_patent_auction,
    execute_event,
    execute_event_with_redraws,
    resume_pending_event,
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
        result = settle_silent_auction(state, patent, bids={0: 0, 1: 0, 2: 0}, active_player=state.players[0])
        assert result is None

    def test_highest_bidder_wins(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test")
        result = settle_silent_auction(state, patent, bids={0: 5, 1: 20, 2: 10}, active_player=state.players[0])
        assert result is not None
        winner_idx, amount = result
        assert winner_idx == 1
        # Pays runner_up + 5 = 10 + 5 = 15
        assert amount == 15

    def test_ties_broken_by_turn_order(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test")
        result = settle_silent_auction(state, patent, bids={0: 20, 1: 20, 2: 5}, active_player=state.players[0])
        winner_idx, amount = result
        assert winner_idx == 0  # seat 0 drew the event, so they win the tie
        # Tied bids: winner pays their own bid (not runner_up + $5)
        assert amount == 20

    def test_ties_break_from_initiator_not_seat_zero(self):
        """Tie-break rank is relative to the player who drew the event.

        Regression: previously ties broke by raw seat index, so seat 0 always
        won ties regardless of whose turn triggered the auction. Now, the
        player who drew the event gets first crack, then the next player in
        turn order, and so on.
        """
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test")
        # P0 and P1 tied at 20. If P2 drew the event, tie-break order is
        # P2 -> P0 -> P1, so P0 wins the tie (distance 1 from initiator)
        # over P1 (distance 2).
        result = settle_silent_auction(
            state, patent, bids={0: 20, 1: 20, 2: 0}, active_player=state.players[2],
        )
        assert result[0] == 0

        # Now ties between P1 and P2 with P1 drawing — P1 wins (distance 0)
        # even though P2 has a lower "next in turn order" distance than the
        # old bug-compat seat-0 tiebreak would have favored.
        state2 = GameState.create(cards, contracts, num_players=3)
        result2 = settle_silent_auction(
            state2, patent, bids={0: 0, 1: 15, 2: 15}, active_player=state2.players[1],
        )
        assert result2[0] == 1

        # And P0 wins when P0 draws a tie with P2 (distance 0 vs 2)
        state3 = GameState.create(cards, contracts, num_players=3)
        result3 = settle_silent_auction(
            state3, patent, bids={0: 10, 1: 0, 2: 10}, active_player=state3.players[0],
        )
        assert result3[0] == 0

    def test_only_one_bidder_pays_5(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test")
        result = settle_silent_auction(state, patent, bids={0: 25, 1: 0, 2: 0}, active_player=state.players[0])
        winner_idx, amount = result
        assert winner_idx == 0
        assert amount == 5  # runner_up = 0, so pays 0 + 5 = 5

    def test_winner_takes_patent_and_rates(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test", rates=[(Resource.PWR, 1), (Resource.FE, 2)])
        rate_pwr_before = state.players[1].rate(Resource.PWR)
        rate_fe_before = state.players[1].rate(Resource.FE)
        settle_silent_auction(state, patent, bids={0: 10, 1: 20}, active_player=state.players[0])
        assert patent in state.players[1].buildings_played
        assert state.players[1].rate(Resource.PWR) == rate_pwr_before + 1
        assert state.players[1].rate(Resource.FE) == rate_fe_before + 2

    def test_winner_pays_debt_not_cash(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        patent = _patent("Test")
        money_before = state.players[1].money
        debt_before = state.players[1].debt
        settle_silent_auction(state, patent, bids={0: 10, 1: 20}, active_player=state.players[0])
        assert state.players[1].money == money_before  # cash unchanged
        assert state.players[1].debt == debt_before + 15  # debt grows by 10+5


# --- do_patent_auction ---


class TestDoPatentAuction:
    def test_empty_pile_is_noop(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        # patent_pile defaults to empty
        detail = do_patent_auction(state, state.players[0])
        assert "no patents" in detail.lower()

    def test_runs_silent_auction_with_ai_bids(self):
        cards, contracts = _load()
        patents = [_patent("AlphaPatent", rates=[(Resource.PWR, 1)])]
        state = GameState.create(cards, contracts, num_players=3, patent_pile=patents)
        # With default cash, every player should bid the same heuristic amount,
        # and ties go to seat 0.
        detail = do_patent_auction(state, state.players[0])
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
        detail = do_patent_auction(state, state.players[0])
        assert any(c.building == "BetaPatent" for c in state.players[1].buildings_played)
        # Pending bids should be cleared after consumption
        assert state.pending_bids == {}

    def test_pile_advances_per_auction(self):
        """Each auction consumes one patent from the top of the pile."""
        cards, contracts = _load()
        patents = [_patent("First"), _patent("Second"), _patent("Third")]
        state = GameState.create(cards, contracts, num_players=3, patent_pile=patents)
        detail1 = do_patent_auction(state, state.players[0])
        detail2 = do_patent_auction(state, state.players[0])
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
        bid = _default_ai_bid(state, state.players[0], _patent("X"))
        assert bid == 0

    def test_negative_net_no_bid(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].money = 5
        state.players[0].debt = 20
        bid = _default_ai_bid(state, state.players[0], _patent("X"))
        assert bid == 0

    def test_bid_in_5_increments(self):
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].money = 100
        state.players[0].debt = 0
        bid = _default_ai_bid(state, state.players[0], _patent("X", rates=[(Resource.PWR, 2)]))
        assert bid % 5 == 0

    def test_bid_based_on_value_not_cash(self):
        """AI bids based on patent value, willing to go into debt."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].money = 5
        state.players[0].debt = 0
        bid = _default_ai_bid(state, state.players[0], _patent("X", rates=[(Resource.PWR, 10)]))
        # Patent with +10 PWR is valuable — AI should bid well above $5 cash
        assert bid >= 5
        assert bid % 5 == 0

    def test_bid_scales_with_patent_value(self):
        """Higher-rate patents draw bigger bids, averaged over several
        samples so per-call jitter in _default_ai_bid (±$10 noise) can't
        flip the comparison when a low-value patent's target rounds up
        to meet a high-value patent's lower-bound."""
        import random as _random
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].money = 100
        state.players[0].debt = 0
        _random.seed(12345)
        samples = 20
        weak_total = sum(
            _default_ai_bid(state, state.players[0], _patent("Weak", rates=[(Resource.PWR, 1)]))
            for _ in range(samples)
        )
        strong_total = sum(
            _default_ai_bid(state, state.players[0], _patent("Strong", rates=[(Resource.PWR, 4)]))
            for _ in range(samples)
        )
        assert strong_total > weak_total

    def test_minimum_bid_floor(self):
        """A patent with positive rates always gets at least the $5 minimum bid."""
        cards, contracts = _load()
        state = GameState.create(cards, contracts, num_players=3)
        state.players[0].money = 50
        state.players[0].debt = 0
        bid = _default_ai_bid(state, state.players[0], _patent("Tiny", rates=[(Resource.PWR, 1)]))
        assert bid >= 5


# --- Mid-event interruption (auction prompt) ---


class TestAuctionPrompt:
    def test_event_pauses_when_human_present(self):
        """A patent_auction event sets pending_prompt and does not draw the patent."""
        cards, contracts = _load()
        patents = [_patent("Alpha"), _patent("Beta")]
        state = GameState.create(
            cards, contracts, num_players=3, patent_pile=patents,
        )
        state._is_human_game = True
        idx_before = state.patent_idx
        execute_event_with_redraws(state, _ec(EventType.PATENT_AUCTION), state.players[0])
        # Paused; the patent has NOT been drawn yet (just peeked)
        assert state.pending_prompt is not None
        assert state.pending_prompt["kind"] == "patent_auction"
        assert state.patent_idx == idx_before

    def test_resume_settles_with_supplied_bids(self):
        cards, contracts = _load()
        patent = _patent("Alpha", rates=[(Resource.PWR, 1)])
        state = GameState.create(
            cards, contracts, num_players=3, patent_pile=[patent],
        )
        state._is_human_game = True
        execute_event_with_redraws(state, _ec(EventType.PATENT_AUCTION), state.players[0])
        # Now supply bids and resume
        state.pending_bids = {0: 25, 1: 0, 2: 0}
        resume_pending_event(state, state.players[0])
        # The auction settled, P0 should own the patent for 0+5 = 5 debt
        assert any(c.building == "Alpha" for c in state.players[0].buildings_played)
        assert state.players[0].debt == 5
        assert state.pending_prompt is None

    def test_no_pause_in_all_ai_game(self):
        """Without _is_human_game flag, the auction fires immediately with AI bids."""
        cards, contracts = _load()
        state = GameState.create(
            cards, contracts, num_players=3, patent_pile=[_patent("Alpha")],
        )
        # _is_human_game not set
        execute_event_with_redraws(state, _ec(EventType.PATENT_AUCTION), state.players[0])
        assert state.pending_prompt is None
        # The patent was drawn and auctioned
        assert state.patent_idx == 1

    def test_playable_game_pauses_and_resumes(self):
        """End-to-end via PlayableGame."""
        game = PlayableGame(seed=42, max_turns=8)
        # Force the next event of the human turn to be a patent auction
        game.begin_human_turn()
        # Replace the pending event with a patent auction so we can test the path
        game.state.patent_pile = [_patent("Test", rates=[(Resource.PWR, 1)])]
        game.state.patent_idx = 0
        game._pending_event = _ec(EventType.PATENT_AUCTION)
        game.apply_human_action({"type": "pass"})
        result = game.end_human_turn()
        assert result.get("awaiting_prompt") is True
        assert game.is_awaiting_prompt()
        prompt = game.pending_prompt()
        assert prompt["kind"] == "patent_auction"
        # Resolve
        resolve_result = game.resolve_pending_prompt({"bids": {0: 10}})
        assert resolve_result["ok"]
        assert not game.is_awaiting_prompt()
        # P0 should have won (only positive bid)
        assert any(c.building == "Test" for c in game.state.players[0].buildings_played)

    def test_chain_suspended_auction_does_not_skip_next_turn(self):
        """When a chained redraw lands on a patent auction, the *current*
        player's turn must stay in progress until the auction resolves —
        the auction must NOT leak into the next player's turn.

        Regression: end_human_turn used to unconditionally call
        _finalize_human_turn after _chain_redraws. If the chain had
        suspended on a prompt, the next player's begin_human_turn would
        then re-show the stale prompt and resolve_pending_prompt would
        consume THEIR turn to settle the auction — the next player never
        got to build/sell/contract.
        """
        game = PlayableGame(seed=42, max_turns=8)
        game.state.patent_pile = [_patent("ChainedPatent", rates=[(Resource.PWR, 1)])]
        game.state.patent_idx = 0

        # Seed the deck so the human's primary event is a redraws=True
        # news card and the NEXT event (which the chain will peek) is a
        # patent auction. Replace the existing two slots rather than
        # inserting, so event_idx math matches what begin_human_turn /
        # end_human_turn expect.
        start = game.state.event_idx
        news_redraw = _ec(EventType.NEWS_BULLETIN, redraws=True)
        auction_event = _ec(EventType.PATENT_AUCTION)
        game.state.event_deck[start : start + 2] = [news_redraw, auction_event]

        game.begin_human_turn()
        game.apply_human_action({"type": "pass"})
        result = game.end_human_turn()

        # Must return awaiting_prompt WITHOUT finalizing. Turn is still in
        # progress for the original player.
        assert result.get("awaiting_prompt") is True, (
            "end_human_turn returned a finalized result even though the "
            "redraw chain suspended on a prompt — next player's turn will "
            "be consumed by the stale auction."
        )
        assert game.human_turn_in_progress is True
        assert game.is_awaiting_prompt()
        assert game.pending_prompt()["kind"] == "patent_auction"
        # Resolve and confirm the turn finalizes cleanly, without touching
        # the next player's turn.
        turn_count_before = game._turn_count
        resolve_result = game.resolve_pending_prompt({"bids": {0: 10}})
        assert resolve_result["ok"]
        assert not game.is_awaiting_prompt()
        # The same player's turn finalized — _turn_count should not have
        # advanced past what begin_human_turn set it to.
        assert game._turn_count == turn_count_before
        # And the current player's buildings_played should include the patent
        # (they were the only bidder).
        assert any(
            c.building == "ChainedPatent" for c in game.state.players[0].buildings_played
        )

"""Tests for the interactive play adapter."""

import pytest

from my_project.play_adapter import PlayableGame
from my_project.simulation import EventType


def test_game_initializes():
    game = PlayableGame(seed=42)
    assert not game.is_over()
    assert game.num_players == 3
    assert game.human_index == 0
    state = game.state_dict()
    assert state["round"] == 1
    assert len(state["players"]) == 3
    assert len(state["market"]) == 9
    # Hand only revealed for the human
    assert len(state["players"][0]["hand"]) == 4
    assert state["players"][1]["hand"] == []
    assert state["players"][2]["hand"] == []


def test_event_deck_is_hidden():
    game = PlayableGame(seed=42)
    state = game.state_dict()
    # state_dict must not expose upcoming events
    assert "event_deck" not in state
    assert "event_idx" not in state
    # last_event is empty before any event fires
    assert state["last_event"] == ""


def test_pass_action_ends_turn():
    game = PlayableGame(seed=42)
    assert game.is_human_turn()
    game.begin_human_turn()
    result = game.apply_human_action({"type": "pass"})
    assert result["ok"]
    event_result = game.end_human_turn()
    assert "type" in event_result
    # After ending, the turn advances. It may hit a patent auction prompt
    # (which pauses for human input) or proceed to an AI turn.
    assert (
        not game.is_human_turn()
        or game.is_over()
        or game.state.pending_prompt is not None
    )


def test_ai_turn_runs():
    game = PlayableGame(seed=42, num_rounds=1, disable_prompts=True)
    # Skip human turn
    game.begin_human_turn()
    game.apply_human_action({"type": "pass"})
    game.end_human_turn()
    # Now AI turns — step until it's the human's turn again or game over
    ai_turns_taken = 0
    while not game.is_human_turn() and not game.is_over():
        result = game.step_ai_turn()
        if not result.get("ok"):
            break
        assert "actions" in result
        assert "event" in result
        ai_turns_taken += 1
    assert ai_turns_taken == 2  # 3-player game, human + 2 AIs


def test_full_game_completes():
    """Drive a full game with the human passing every turn + AI stepping."""
    # disable_prompts skips the auction / OC pause flow so the test loop
    # doesn't have to handle resolve_pending_prompt mid-event.
    game = PlayableGame(seed=42, max_turns=8, num_rounds=1, disable_prompts=True)
    safety_counter = 0
    while not game.is_over():
        if game.is_human_turn():
            game.begin_human_turn()
            if game.is_over():
                break
            game.apply_human_action({"type": "pass"})
            game.end_human_turn()
        else:
            result = game.step_ai_turn()
            if not result.get("ok"):
                break
        safety_counter += 1
        assert safety_counter < 100, "Game did not terminate"
    assert game.is_over()
    scores = game.final_scores()
    assert len(scores) == 3
    assert scores[0]["net_worth"] >= scores[-1]["net_worth"]


def test_legal_actions_reports_affordable_builds():
    game = PlayableGame(seed=42)
    legal = game.legal_human_actions()
    assert isinstance(legal["affordable_single_builds"], list)
    assert isinstance(legal["can_sell"], list)
    assert isinstance(legal["can_contract"], list)
    assert legal["already_built"] is False


def test_illegal_action_returns_reason():
    game = PlayableGame(seed=42)
    game.begin_human_turn()
    # Invalid sell index
    result = game.apply_human_action({"type": "sell", "card_idx": 99})
    assert not result["ok"]
    assert "reason" in result


def test_build_action_affects_state():
    game = PlayableGame(seed=42)
    game.begin_human_turn()
    legal = game.legal_human_actions()
    if legal["affordable_single_builds"]:
        card_idx = legal["affordable_single_builds"][0]["card_idx"]
        before = game.state_dict()
        money_before = before["players"][0]["money"]
        hand_before = len(before["players"][0]["hand"])
        result = game.apply_human_action({
            "type": "build",
            "build_cards": [card_idx],
        })
        assert result["ok"]
        after = game.state_dict()
        # Either money decreased or a building was added
        player_after = after["players"][0]
        assert player_after["money"] <= money_before
        assert len(player_after["buildings_played"]) >= 1
        # Hand shrinks (card consumed)
        assert len(player_after["hand"]) == hand_before - 1


def test_one_build_per_turn():
    """A second build action in the same turn must be rejected."""
    game = PlayableGame(seed=42)
    game.begin_human_turn()
    legal = game.legal_human_actions()
    if not legal["affordable_single_builds"]:
        pytest.skip("No affordable build available with this seed")

    first_idx = legal["affordable_single_builds"][0]["card_idx"]
    result = game.apply_human_action({
        "type": "build",
        "build_cards": [first_idx],

    })
    assert result["ok"]

    # State should now report already_built
    state = game.state_dict()
    assert state["human_already_built"] is True
    legal2 = game.legal_human_actions()
    assert legal2["already_built"] is True
    assert legal2["affordable_single_builds"] == []

    # Attempting another build must fail
    # Find any remaining card index (hand shrank after the first build)
    remaining_cards = len(state["players"][0]["hand"])
    if remaining_cards > 0:
        result2 = game.apply_human_action({
            "type": "build",
            "build_cards": [0],
        })
        assert not result2["ok"]
        assert "already built" in result2["reason"].lower()


def test_build_flag_resets_each_turn():
    """has_built_this_turn should reset at the start of each turn."""
    game = PlayableGame(seed=42, max_turns=8)
    # Drive a few turns to verify the flag resets
    for _ in range(4):
        if game.is_over():
            break
        if game.is_human_turn():
            game.begin_human_turn()
            state = game.state_dict()
            # Flag should be False at the start of each human turn
            assert not state["human_already_built"]
            game.apply_human_action({"type": "pass"})
            game.end_human_turn()
        else:
            game.step_ai_turn()


def test_pool_swap_before_action():
    """Human pool swap works before any action is taken."""
    game = PlayableGame(seed=42)
    # Capture pool card 0 and hand card 0 names
    state_before = game.state_dict()
    assert game.can_pool_swap()
    hand0_before = state_before["players"][0]["hand"][0]["building"]
    pool0_before = state_before["pool"][0]["building"]
    # Swap
    result = game.human_pool_swap(0, 0)
    assert result["ok"]
    state_after = game.state_dict()
    assert state_after["players"][0]["hand"][0]["building"] == pool0_before
    assert state_after["pool"][0]["building"] == hand0_before
    assert game.can_pool_swap()  # still allowed — no actions yet


def test_pool_swap_allowed_after_action():
    """Pool swaps are free and unlimited — still allowed after a build action."""
    game = PlayableGame(seed=42)
    game.begin_human_turn()
    legal = game.legal_human_actions()
    if not legal["affordable_single_builds"]:
        pytest.skip("No affordable build available with this seed")
    card_idx = legal["affordable_single_builds"][0]["card_idx"]
    result = game.apply_human_action({
        "type": "build",
        "build_cards": [card_idx],

    })
    assert result["ok"]
    # Swap should still be allowed after the build action
    assert game.can_pool_swap()
    state_before = game.state_dict()
    hand_names_before = [c["building"] for c in state_before["players"][0]["hand"]]
    pool_names_before = [c["building"] for c in state_before["pool"]]
    if not hand_names_before or not pool_names_before:
        pytest.skip("Empty hand or pool")
    swap_result = game.human_pool_swap(0, 0)
    assert swap_result["ok"]
    state_after = game.state_dict()
    assert state_after["players"][0]["hand"][0]["building"] == pool_names_before[0]
    assert state_after["pool"][0]["building"] == hand_names_before[0]


def test_deterministic_with_seed():
    g1 = PlayableGame(seed=12345)
    g2 = PlayableGame(seed=12345)
    s1 = g1.state_dict()
    s2 = g2.state_dict()
    # Same seed → same initial state
    assert s1["market"] == s2["market"]
    # Player hands should be identical too (same deck shuffle)
    assert [c["building"] for c in s1["players"][0]["hand"]] == [
        c["building"] for c in s2["players"][0]["hand"]
    ]


def test_default_player_names():
    """Without custom names, players keep the engine's Player_N defaults."""
    game = PlayableGame(seed=42)
    state = game.state_dict()
    assert [p["name"] for p in state["players"]] == ["Player_1", "Player_2", "Player_3"]


def test_custom_player_names():
    """Custom names override the engine defaults; empty entries fall back."""
    game = PlayableGame(seed=42, names=["Roland", "Alex", ""])
    state = game.state_dict()
    assert [p["name"] for p in state["players"]] == ["Roland", "Alex", "Player_3"]


def test_custom_names_length_mismatch_raises():
    with pytest.raises(ValueError):
        PlayableGame(seed=42, names=["Only one"])


def test_current_player_index_stable_across_begin():
    """begin_human_turn pre-advances event_idx internally. Public accessors
    (current_player_index, turn_number, round_number) must stay stable for the
    active player during the turn, not jump ahead to the next player.
    """
    game = PlayableGame(seed=42)
    before_idx = game.current_player_index()
    before_turn = game.turn_number()
    before_round = game.round_number()
    assert game.is_human_turn()
    game.begin_human_turn()
    assert game.current_player_index() == before_idx
    assert game.turn_number() == before_turn
    assert game.round_number() == before_round
    # state_dict's turn_index should also stay stable (play.js does
    # `turn_index + 1` to display "turn N/24")
    state = game.state_dict()
    assert state["turn_index"] == before_turn - 1
    assert state["round"] == before_round


def test_strategy_cannot_see_current_event_in_ai_turn():
    """When the AI acts, its strategy must NOT see the current turn's event
    in state.remaining_events(). This is the bug the user reported.
    """
    game = PlayableGame(seed=42, disable_prompts=True)
    # Skip the human turn so the next step_ai_turn actually runs an AI player
    game.begin_human_turn()
    game.apply_human_action({"type": "pass"})
    game.end_human_turn()
    # Now it's an AI player's turn. Peek at the current turn's event.
    current_event = game.state.event_deck[game.state.event_idx]
    current_type = current_event.type

    # Count occurrences of this event type in the full deck from event_idx
    # onward, INCLUDING and EXCLUDING the current one.
    deck_from_here = game.state.event_deck[game.state.event_idx:]
    count_including = sum(1 for e in deck_from_here if e.type == current_type)

    # Monkeypatch the strategy to inspect remaining_events mid-turn.
    # play_adapter imports smart_greedy_strategy at module load, so we need
    # to patch the reference on the play_adapter module itself.
    from my_project import play_adapter as pa_mod
    original = pa_mod.smart_greedy_strategy
    observed = {}

    def spy(state, player):
        if "remaining" not in observed:
            observed["remaining"] = dict(state.remaining_events())
            observed["event_idx"] = state.event_idx
        return original(state, player)

    if hasattr(original, "pool_swap"):
        spy.pool_swap = original.pool_swap
    pa_mod.smart_greedy_strategy = spy
    try:
        game.step_ai_turn()
    finally:
        pa_mod.smart_greedy_strategy = original

    assert "remaining" in observed, "Strategy was not called — can't verify"
    # The strategy's view should exclude the current turn's event: one fewer
    # of this event type than the raw count-from-current-index.
    seen = observed["remaining"].get(current_type, 0)
    assert seen == count_including - 1, (
        f"Strategy saw {seen} of {current_type.value}, expected {count_including - 1} "
        f"(current turn's event should be hidden). event_idx={observed['event_idx']}."
    )


def test_last_player_gets_full_turn_before_end_game():
    """The final player-turn must have a fresh action phase BEFORE END_GAME
    fires. The last_event must contain the END_GAME detail string."""
    # num_rounds=1 so the game plays through the deck once.
    # disable_prompts so this test doesn't have to dance around the auction
    # pause flow when patent auctions fire.
    game = PlayableGame(seed=42, max_turns=8, num_rounds=1, disable_prompts=True)

    last_event_detail = None
    safety = 0
    while not game.is_over():
        if game.is_human_turn():
            game.begin_human_turn()
            game.apply_human_action({"type": "pass"})
            result = game.end_human_turn()
            last_event_detail = result.get("detail", "")
        else:
            result = game.step_ai_turn()
            last_event_detail = (result.get("event") or {}).get("detail", "")
        safety += 1
        assert safety < 100, "Game didn't terminate"

    assert game.is_over()
    # The very last event in the game must be END GAME
    assert "end_game" in game.last_event.lower() or "END GAME" in game.last_event, (
        f"Last event was not END GAME: {game.last_event}"
    )

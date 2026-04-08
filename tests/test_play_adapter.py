"""Tests for the interactive play adapter."""

import pytest

from my_project.play_adapter import PlayableGame


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
    assert len(state["players"][0]["hand"]) == 3
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
    # After ending, it should be an AI player's turn (or game could still be human
    # if num_players == 1, but we're 3p)
    assert not game.is_human_turn() or game.is_over()


def test_ai_turn_runs():
    game = PlayableGame(seed=42)
    # Skip human turn
    game.begin_human_turn()
    game.apply_human_action({"type": "pass"})
    game.end_human_turn()
    # Now AI turns
    while not game.is_human_turn() and not game.is_over():
        result = game.step_ai_turn()
        assert result["ok"]
        assert "actions" in result
        assert "event" in result


def test_full_game_completes():
    """Drive a full game with the human passing every turn + AI stepping."""
    game = PlayableGame(seed=42, max_turns=8)
    safety_counter = 0
    while not game.is_over():
        if game.is_human_turn():
            game.begin_human_turn()
            game.apply_human_action({"type": "pass"})
            game.end_human_turn()
        else:
            game.step_ai_turn()
        safety_counter += 1
        assert safety_counter < 50, "Game did not terminate"
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
            "discard_cards": [],
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
        "discard_cards": [],
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
            "discard_cards": [],
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
        "discard_cards": [],
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

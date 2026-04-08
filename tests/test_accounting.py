"""Tests for the rate cost accounting system.

Uses worked examples from the design discussion to verify
the ledger produces correct cost tracking.
"""

from my_project.accounting import CostLedger
from my_project.models import Resource, ResourceAmount


def _prices(fe=3, pwr=2, h2o=3, si=3, c=3, o2=3, food=4, gls=4, elx=5):
    """Helper to create a price dict."""
    return {
        Resource.FE: fe, Resource.PWR: pwr, Resource.H2O: h2o,
        Resource.SI: si, Resource.C: c, Resource.O2: o2,
        Resource.FOOD: food, Resource.GLS: gls, Resource.ELX: elx,
    }


def _zero_rates():
    return {r: 0 for r in Resource}


class TestBasicBuild:
    def test_free_building_with_negative_rate(self):
        """Iron Mine: +1 FE, -2 PWR, no build cost."""
        ledger = CostLedger.create()
        prices = _prices()
        rates = _zero_rates()

        ledger.record_build(
            costs=[],
            positive_rates=[ResourceAmount(Resource.FE, 1)],
            negative_rates=[ResourceAmount(Resource.PWR, 2)],
            market_spend=0,
            market_prices=prices,
            player_rates=rates,
        )

        # FE gets $0 cost (no build cost)
        assert ledger.accounts[Resource.FE].balance == 0
        assert ledger.accounts[Resource.FE].rate == 1

        # PWR has -2 rate, FE owns the negative shares
        assert ledger.accounts[Resource.PWR].rate == -2
        cap = ledger.cap_tables[Resource.PWR]
        assert cap.total_negative() == 2
        assert cap.negative_shares[0].owner == Resource.FE
        assert cap.negative_shares[0].shares == 2

    def test_building_with_market_cost(self):
        """Solar Panel: +2 PWR, costs 1 SI, market $3."""
        ledger = CostLedger.create()
        prices = _prices(si=3)
        rates = _zero_rates()

        ledger.record_build(
            costs=[ResourceAmount(Resource.SI, 1)],
            positive_rates=[ResourceAmount(Resource.PWR, 2)],
            negative_rates=[],
            market_spend=3,
            market_prices=prices,
            player_rates=rates,
        )

        # PWR gets cost = 1 SI * $3 = $3
        assert ledger.accounts[Resource.PWR].balance == 3
        assert ledger.accounts[Resource.PWR].rate == 2

    def test_rate_covers_build_cost(self):
        """Building costs 2 FE, player has +2 FE rate. FE earns revenue."""
        ledger = CostLedger.create()
        ledger.accounts[Resource.FE].rate = 2
        ledger.accounts[Resource.FE].balance = 10  # FE has $10 cost basis
        prices = _prices(fe=3)
        rates = {r: 0 for r in Resource}
        rates[Resource.FE] = 2

        ledger.record_build(
            costs=[ResourceAmount(Resource.FE, 2)],
            positive_rates=[ResourceAmount(Resource.GLS, 2)],
            negative_rates=[],
            market_spend=0,
            market_prices=prices,
            player_rates=rates,
        )

        # GLS costs 2 FE * $3 = $6
        assert ledger.accounts[Resource.GLS].balance == 6
        # FE earns $6 revenue (covered the build)
        assert ledger.accounts[Resource.FE].balance == 10 - 6  # $4


class TestPowerBillEvent:
    def test_power_bill_charges_negative_shareholders(self):
        """Iron Mine creates -2 PWR owned by FE. Power bill charges FE."""
        ledger = CostLedger.create()
        prices = _prices()
        rates = _zero_rates()

        # Build Iron Mine
        ledger.record_build(
            costs=[],
            positive_rates=[ResourceAmount(Resource.FE, 1)],
            negative_rates=[ResourceAmount(Resource.PWR, 2)],
            market_spend=0,
            market_prices=prices,
            player_rates=rates,
        )

        # Power bill: rate -2, price $2, cost = $4
        ledger.record_event_cost(Resource.PWR, 4.0, player_rate=-2)

        # FE absorbs the $4 (owns all negative PWR shares)
        assert ledger.accounts[Resource.FE].balance == 4


class TestShareSettlement:
    def test_positive_rate_retires_negative_shares(self):
        """Iron Mine (-2 PWR for FE), then Solar Panel (+2 PWR).
        Solar Panel cost goes to FE to close the position."""
        ledger = CostLedger.create()
        prices = _prices(si=3)
        rates = _zero_rates()

        # Iron Mine: +1 FE, -2 PWR
        ledger.record_build(
            costs=[],
            positive_rates=[ResourceAmount(Resource.FE, 1)],
            negative_rates=[ResourceAmount(Resource.PWR, 2)],
            market_spend=0,
            market_prices=prices,
            player_rates=rates,
        )

        # Solar Panel: +2 PWR, costs 1 SI ($3)
        rates_after_mine = _zero_rates()
        rates_after_mine[Resource.FE] = 1
        rates_after_mine[Resource.PWR] = -2

        ledger.record_build(
            costs=[ResourceAmount(Resource.SI, 1)],
            positive_rates=[ResourceAmount(Resource.PWR, 2)],
            negative_rates=[],
            market_spend=3,
            market_prices=prices,
            player_rates=rates_after_mine,
        )

        # PWR cap table should be empty (settled)
        assert ledger.cap_tables[Resource.PWR].total_negative() == 0
        # PWR rate should be 0
        assert ledger.accounts[Resource.PWR].rate == 0
        # FE absorbed the Solar Panel cost ($3)
        assert ledger.accounts[Resource.FE].balance == 3

    def test_partial_settlement(self):
        """Two Iron Mines (-4 PWR for FE), Solar Panel (+2 PWR).
        Only 2 of 4 shares retire."""
        ledger = CostLedger.create()
        prices = _prices(si=3)
        rates = _zero_rates()

        # Two Iron Mines
        for _ in range(2):
            ledger.record_build(
                costs=[],
                positive_rates=[ResourceAmount(Resource.FE, 1)],
                negative_rates=[ResourceAmount(Resource.PWR, 2)],
                market_spend=0,
                market_prices=prices,
                player_rates=rates,
            )
            rates[Resource.FE] += 1
            rates[Resource.PWR] -= 2

        # FE has -4 PWR shares, FE rate = 2
        assert ledger.cap_tables[Resource.PWR].total_negative() == 4

        # Solar Panel: +2 PWR
        ledger.record_build(
            costs=[ResourceAmount(Resource.SI, 1)],
            positive_rates=[ResourceAmount(Resource.PWR, 2)],
            negative_rates=[],
            market_spend=3,
            market_prices=prices,
            player_rates=rates,
        )

        # 2 shares retired, 2 remain
        assert abs(ledger.cap_tables[Resource.PWR].total_negative() - 2) < 0.01
        assert ledger.accounts[Resource.PWR].rate == -2


class TestDependencyChain:
    def test_full_chain_water_pump_to_food(self):
        """Water Pump (+1 H2O, -1 PWR, costs 1 FE $4) then
        Hydroponic Farm (+2 FOOD, -1 H2O, costs 1 FE $3).
        H2O settles immediately into FOOD. FOOD inherits PWR liability."""
        ledger = CostLedger.create()
        prices = _prices(fe=4)

        # Water Pump: +1 H2O, -1 PWR, costs 1 FE
        ledger.record_build(
            costs=[ResourceAmount(Resource.FE, 1)],
            positive_rates=[ResourceAmount(Resource.H2O, 1)],
            negative_rates=[ResourceAmount(Resource.PWR, 1)],
            market_spend=4,
            market_prices=prices,
            player_rates=_zero_rates(),
        )

        assert ledger.accounts[Resource.H2O].rate == 1
        assert ledger.accounts[Resource.H2O].balance == 4  # 1 FE * $4
        assert ledger.accounts[Resource.PWR].rate == -1
        # H2O owns -1 PWR share
        assert ledger.cap_tables[Resource.PWR].negative_shares[0].owner == Resource.H2O

        # Hydroponic Farm: +2 FOOD, -1 H2O, costs 1 FE
        prices2 = _prices(fe=3)
        rates_now = _zero_rates()
        rates_now[Resource.H2O] = 1
        rates_now[Resource.PWR] = -1

        ledger.record_build(
            costs=[ResourceAmount(Resource.FE, 1)],
            positive_rates=[ResourceAmount(Resource.FOOD, 2)],
            negative_rates=[ResourceAmount(Resource.H2O, 1)],
            market_spend=3,
            market_prices=prices2,
            player_rates=rates_now,
        )

        # H2O should be settled: rate 0, balance 0
        assert ledger.accounts[Resource.H2O].rate == 0

        # FOOD should have: build cost ($3) + H2O cost basis ($4)
        assert ledger.accounts[Resource.FOOD].balance == 3 + 4
        assert ledger.accounts[Resource.FOOD].rate == 2

        # FOOD should have inherited H2O's PWR liability
        pwr_cap = ledger.cap_tables[Resource.PWR]
        food_shares = [ns for ns in pwr_cap.negative_shares if ns.owner == Resource.FOOD]
        assert len(food_shares) == 1
        assert abs(food_shares[0].shares - 1) < 0.01


class TestSelling:
    def test_sell_reduces_cost_basis(self):
        """H2O has $6 cost basis. Sell for $4. Cost basis becomes $2."""
        ledger = CostLedger.create()
        ledger.accounts[Resource.H2O].balance = 6
        ledger.accounts[Resource.H2O].rate = 1

        ledger.record_sell(Resource.H2O, 4)

        assert ledger.accounts[Resource.H2O].balance == 2

    def test_sell_creates_profit(self):
        """H2O has $6 cost basis. Sell for $10. Profit = $4."""
        ledger = CostLedger.create()
        ledger.accounts[Resource.H2O].balance = 6
        ledger.accounts[Resource.H2O].rate = 1

        ledger.record_sell(Resource.H2O, 10)

        assert ledger.accounts[Resource.H2O].balance == -4
        assert ledger.accounts[Resource.H2O].profit == 4
        assert ledger.accounts[Resource.H2O].cost_basis == 0

    def test_profitable_resource_consumed_for_free(self):
        """H2O is profitable ($4 profit). FOOD consumes it. FOOD pays $0."""
        ledger = CostLedger.create()
        ledger.accounts[Resource.H2O].balance = -4  # profitable
        ledger.accounts[Resource.H2O].rate = 1

        # Hydroponic Farm: +2 FOOD, -1 H2O
        ledger.record_build(
            costs=[ResourceAmount(Resource.FE, 1)],
            positive_rates=[ResourceAmount(Resource.FOOD, 2)],
            negative_rates=[ResourceAmount(Resource.H2O, 1)],
            market_spend=3,
            market_prices=_prices(fe=3),
            player_rates={r: 0 for r in Resource} | {Resource.H2O: 1},
        )

        # FOOD cost = $3 build + $0 H2O (cost basis was 0, H2O was profitable)
        assert ledger.accounts[Resource.FOOD].balance == 3


class TestContractCost:
    def test_contract_cost_basic(self):
        """FOOD has $14 cost basis, 4 rate. Contract costs 3 FOOD."""
        ledger = CostLedger.create()
        ledger.accounts[Resource.FOOD].balance = 14
        ledger.accounts[Resource.FOOD].rate = 4

        cost = ledger.contract_cost([ResourceAmount(Resource.FOOD, 3)])
        # 3/4 * $14 = $10.50
        assert cost == 10.5

    def test_contract_reduces_balance(self):
        """After fulfilling contract, balance and rate reduce proportionally."""
        ledger = CostLedger.create()
        ledger.accounts[Resource.FOOD].balance = 14
        ledger.accounts[Resource.FOOD].rate = 4

        ledger.record_contract([ResourceAmount(Resource.FOOD, 3)])

        assert ledger.accounts[Resource.FOOD].rate == 1
        assert abs(ledger.accounts[Resource.FOOD].balance - 3.5) < 0.01  # 1/4 * $14

    def test_multi_resource_contract(self):
        """Contract requires 2 FOOD + 1 H2O."""
        ledger = CostLedger.create()
        ledger.accounts[Resource.FOOD].balance = 10
        ledger.accounts[Resource.FOOD].rate = 4
        ledger.accounts[Resource.H2O].balance = 8
        ledger.accounts[Resource.H2O].rate = 2

        cost = ledger.contract_cost([
            ResourceAmount(Resource.FOOD, 2),
            ResourceAmount(Resource.H2O, 1),
        ])
        # FOOD: 2/4 * $10 = $5. H2O: 1/2 * $8 = $4. Total = $9
        assert cost == 9.0


class TestProfitAbsorbsCost:
    def test_profit_absorbs_new_cost(self):
        """H2O has profit. New cost is absorbed by profit first."""
        ledger = CostLedger.create()
        ledger.accounts[Resource.H2O].balance = -4  # $4 profit
        ledger.accounts[Resource.H2O].rate = 0

        # New Water Pump adds cost
        ledger.record_build(
            costs=[ResourceAmount(Resource.FE, 1)],
            positive_rates=[ResourceAmount(Resource.H2O, 1)],
            negative_rates=[ResourceAmount(Resource.PWR, 1)],
            market_spend=5,
            market_prices=_prices(fe=5),
            player_rates=_zero_rates(),
        )

        # H2O cost = $5 (1 FE * $5). But had $4 profit credit.
        # New balance = -4 + 5 = $1
        assert ledger.accounts[Resource.H2O].balance == 1
        assert ledger.accounts[Resource.H2O].rate == 1


class TestMultipleNegativeOwners:
    def test_proportional_event_allocation(self):
        """FE owns -4 PWR shares, FOOD owns -1 PWR share.
        Power bill cost allocated 4/5 to FE, 1/5 to FOOD."""
        ledger = CostLedger.create()
        ledger.cap_tables[Resource.PWR].add_shares(Resource.FE, 4)
        ledger.cap_tables[Resource.PWR].add_shares(Resource.FOOD, 1)
        ledger.accounts[Resource.PWR].rate = -5

        ledger.record_event_cost(Resource.PWR, 10.0, player_rate=-5)

        assert abs(ledger.accounts[Resource.FE].balance - 8.0) < 0.01  # 4/5 * $10
        assert abs(ledger.accounts[Resource.FOOD].balance - 2.0) < 0.01  # 1/5 * $10

    def test_proportional_retirement(self):
        """FE owns -4, FOOD owns -1 PWR shares. +2 PWR retires fractionally."""
        ledger = CostLedger.create()
        ledger.cap_tables[Resource.PWR].add_shares(Resource.FE, 4)
        ledger.cap_tables[Resource.PWR].add_shares(Resource.FOOD, 1)
        ledger.accounts[Resource.PWR].rate = -5

        # Build +2 PWR (costs $6)
        ledger.record_build(
            costs=[ResourceAmount(Resource.SI, 2)],
            positive_rates=[ResourceAmount(Resource.PWR, 2)],
            negative_rates=[],
            market_spend=6,
            market_prices=_prices(si=3),
            player_rates=_zero_rates(),
        )

        # 2 shares retired: FE gets 4/5 * 2 = 1.6, FOOD gets 1/5 * 2 = 0.4
        # Remaining: FE = 2.4, FOOD = 0.6
        pwr_cap = ledger.cap_tables[Resource.PWR]
        remaining = {ns.owner: ns.shares for ns in pwr_cap.negative_shares}
        assert abs(remaining.get(Resource.FE, 0) - 2.4) < 0.01
        assert abs(remaining.get(Resource.FOOD, 0) - 0.6) < 0.01

        # Settlement cost ($6) allocated: FE 4/5 * $6 = $4.80, FOOD 1/5 * $6 = $1.20
        assert abs(ledger.accounts[Resource.FE].balance - 4.8) < 0.01
        assert abs(ledger.accounts[Resource.FOOD].balance - 1.2) < 0.01

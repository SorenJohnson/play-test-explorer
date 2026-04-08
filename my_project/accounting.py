"""Rate Cost Accounting System.

Tracks the true cost of producing each resource rate using concrete cost
accounting with no forward-looking estimates.

Key concepts:
- Each resource has an account with a balance (costs - revenue).
  Positive balance = cost basis, negative = profit.
- Each resource has a cap table tracking who owns negative shares.
- When buildings are played, costs flow to positive rate accounts,
  and negative rates create shares on the consumed resource's cap table.
- Shares settle immediately when possible, transferring cost basis
  and liabilities to the closer.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from my_project.models import Resource, ResourceAmount


@dataclass
class ResourceAccount:
    resource: Resource
    balance: float = 0.0  # positive = cost basis, negative = profit
    rate: int = 0
    total_invested: float = 0.0  # gross costs, never reduced by revenue
    total_revenue: float = 0.0  # gross revenue earned

    def add_cost(self, amount: float) -> None:
        self.balance += amount
        self.total_invested += amount

    def add_revenue(self, amount: float) -> None:
        self.balance -= amount
        self.total_revenue += amount

    @property
    def cost_basis(self) -> float:
        return max(0.0, self.balance)

    @property
    def profit(self) -> float:
        return max(0.0, -self.balance)


@dataclass
class NegativeShare:
    owner: Resource
    shares: float


@dataclass
class CapTable:
    resource: Resource
    negative_shares: list[NegativeShare] = field(default_factory=list)

    def total_negative(self) -> float:
        return sum(ns.shares for ns in self.negative_shares)

    def owner_proportions(self) -> dict[Resource, float]:
        """Return proportion of negative shares per owner."""
        total = self.total_negative()
        if total <= 0:
            return {}
        return {ns.owner: ns.shares / total for ns in self.negative_shares if ns.shares > 0}

    def retire_proportionally(self, amount: float) -> dict[Resource, float]:
        """Retire `amount` negative shares proportionally across owners.

        Returns dict of owner -> shares retired.
        """
        total = self.total_negative()
        if total <= 0 or amount <= 0:
            return {}

        amount = min(amount, total)
        retired: dict[Resource, float] = {}

        for ns in self.negative_shares:
            proportion = ns.shares / total
            to_retire = amount * proportion
            ns.shares -= to_retire
            retired[ns.owner] = to_retire

        # Clean up zero shares
        self.negative_shares = [ns for ns in self.negative_shares if ns.shares > 1e-9]
        return retired

    def add_shares(self, owner: Resource, amount: float) -> None:
        for ns in self.negative_shares:
            if ns.owner == owner:
                ns.shares += amount
                return
        self.negative_shares.append(NegativeShare(owner=owner, shares=amount))

    def transfer_shares(self, from_owner: Resource, to_owner: Resource, amount: float) -> None:
        """Transfer negative shares from one owner to another (liability inheritance)."""
        for ns in self.negative_shares:
            if ns.owner == from_owner:
                transfer = min(amount, ns.shares)
                ns.shares -= transfer
                self.add_shares(to_owner, transfer)
                break
        self.negative_shares = [ns for ns in self.negative_shares if ns.shares > 1e-9]


@dataclass
class CostLedger:
    accounts: dict[Resource, ResourceAccount] = field(default_factory=dict)
    cap_tables: dict[Resource, CapTable] = field(default_factory=dict)

    @classmethod
    def create(cls) -> CostLedger:
        accounts = {r: ResourceAccount(resource=r) for r in Resource}
        cap_tables = {r: CapTable(resource=r) for r in Resource}
        return cls(accounts=accounts, cap_tables=cap_tables)

    def record_build(
        self,
        costs: list[ResourceAmount],
        positive_rates: list[ResourceAmount],
        negative_rates: list[ResourceAmount],
        market_spend: int,
        market_prices: dict[Resource, int],
        player_rates: dict[Resource, int],
    ) -> None:
        """Record a building being played.

        Args:
            costs: Build cost resources (e.g., [2 FE, 1 C])
            positive_rates: Positive rates gained (e.g., [+2 GLS])
            negative_rates: Negative rates incurred (e.g., [-1 SI, -1 O2]) as positive amounts
            market_spend: Actual cash spent at market for deficit
            market_prices: Current market price per resource
            player_rates: Player's rates BEFORE this build
        """
        if not positive_rates:
            return  # buildings with no positive rates (shouldn't happen after filtering)

        # 1. Compute full building cost at market value
        full_cost = 0.0
        for ra in costs:
            full_cost += ra.amount * market_prices.get(ra.resource, 0)

        # 2. Credit rate accounts that covered build costs (the non-deficit portion)
        for ra in costs:
            player_rate = max(0, player_rates.get(ra.resource, 0))
            covered = min(player_rate, ra.amount)
            if covered > 0:
                revenue = covered * market_prices.get(ra.resource, 0)
                self.accounts[ra.resource].add_revenue(revenue)

        # 3. Split building cost across positive rates proportionally and update rates
        total_positive = sum(ra.amount for ra in positive_rates)
        for ra in positive_rates:
            proportion = ra.amount / total_positive
            self.accounts[ra.resource].add_cost(full_cost * proportion)
            self.accounts[ra.resource].rate += ra.amount

        # 4. Handle negative rates — create shares and update rates
        for neg_ra in negative_rates:
            neg_resource = neg_ra.resource
            neg_amount = neg_ra.amount  # stored as positive

            # Each positive rate output shares ownership of this negative
            for pos_ra in positive_rates:
                proportion = pos_ra.amount / total_positive
                owner_shares = neg_amount * proportion
                self.cap_tables[neg_resource].add_shares(pos_ra.resource, owner_shares)

            self.accounts[neg_resource].rate -= neg_amount

        # 5. Settle all affected resources
        # For positive rates: settle against pre-existing negative shares
        for ra in positive_rates:
            cap = self.cap_tables[ra.resource]
            if cap.total_negative() > 0:
                self._try_settle(ra.resource, ra.amount)

        # For negative rates: settle if the resource had positive rate before this build
        for neg_ra in negative_rates:
            neg_resource = neg_ra.resource
            cap = self.cap_tables[neg_resource]
            # The positive rate that existed before this build's negatives were applied
            # = current rate + negatives just added (since we subtracted them in step 4)
            pre_negative_rate = self.accounts[neg_resource].rate + neg_ra.amount
            if pre_negative_rate > 0 and cap.total_negative() > 0:
                self._try_settle(neg_resource, min(neg_ra.amount, pre_negative_rate))

    def _try_settle(self, resource: Resource, available_positive: float) -> None:
        """Settle negative shares against positive rate units.

        Retires negative shares, transfers cost basis to the owners of those
        shares, and transfers liabilities. Does NOT change the rate — rates
        are managed by record_build.

        Args:
            resource: The resource whose cap table to settle
            available_positive: Positive units available to retire against
        """
        cap_table = self.cap_tables[resource]
        account = self.accounts[resource]

        total_neg = cap_table.total_negative()
        if total_neg <= 0 or available_positive <= 0:
            return

        # How many shares can we settle?
        settleable = min(available_positive, total_neg)

        # Cost to close: proportional cost basis of the consumed resource
        # The "positive side" = rate + total_negative (since rate is net)
        positive_rate = account.rate + cap_table.total_negative()
        if positive_rate < 0.01:
            # Near-zero positive rate — just retire shares, no meaningful cost to transfer
            cap_table.retire_proportionally(settleable)
            return

        cost_per_unit = account.cost_basis / positive_rate
        total_closing_cost = cost_per_unit * settleable

        # Retire shares proportionally and charge owners
        retired = cap_table.retire_proportionally(settleable)
        total_retired = sum(retired.values())

        for owner, shares in retired.items():
            if total_retired > 0:
                owner_cost = total_closing_cost * (shares / total_retired)
                self.accounts[owner].add_cost(owner_cost)

            # Inherit liabilities
            proportion = shares / (total_retired if total_retired > 0 else 1)
            self._inherit_liabilities(resource, owner, proportion)

        # Reduce the consumed resource's balance proportionally (capped to avoid overshoot)
        proportion_consumed = min(settleable / positive_rate, 1.0)
        account.balance -= account.balance * proportion_consumed

    def _inherit_liabilities(
        self, from_resource: Resource, to_resource: Resource, proportion: float,
        _visited: set[Resource] | None = None,
    ) -> None:
        """Transfer a proportion of from_resource's liabilities to to_resource.

        Prevents circular dependencies by tracking visited resources.
        """
        if _visited is None:
            _visited = set()
        _visited.add(from_resource)
        _visited.add(to_resource)

        for r in Resource:
            if r in _visited:
                continue
            cap = self.cap_tables[r]
            for ns in list(cap.negative_shares):
                if ns.owner == from_resource and ns.shares > 0:
                    transfer = ns.shares * proportion
                    if transfer > 1e-9:
                        cap.transfer_shares(from_resource, to_resource, transfer)

    def record_sell(self, resource: Resource, revenue: int) -> None:
        """Record selling a resource for revenue."""
        self.accounts[resource].add_revenue(revenue)

    def record_event_cost(self, resource: Resource, cost: float, player_rate: int) -> None:
        """Record a cost from an event (power bill, futures settlement).

        Allocates cost to negative shareholders proportionally.
        If no negative shareholders, the cost goes to the resource itself.
        """
        cap_table = self.cap_tables[resource]
        proportions = cap_table.owner_proportions()

        if proportions:
            for owner, prop in proportions.items():
                self.accounts[owner].add_cost(cost * prop)
        elif player_rate < 0:
            # No tracked shareholders — cost goes to the resource itself
            self.accounts[resource].add_cost(cost)

    def contract_cost(self, requirements: list[ResourceAmount]) -> float:
        """Compute the net cost of fulfilling a contract (cost basis after revenue)."""
        total = 0.0
        for req in requirements:
            account = self.accounts[req.resource]
            if account.rate > 0:
                cost_per_unit = account.cost_basis / account.rate
                total += cost_per_unit * req.amount
        return round(total, 2)

    def contract_gross_cost(self, requirements: list[ResourceAmount]) -> float:
        """Compute the gross cost of fulfilling a contract (total invested, ignoring revenue)."""
        total = 0.0
        for req in requirements:
            account = self.accounts[req.resource]
            if account.rate > 0:
                gross_per_unit = account.total_invested / account.rate
                total += gross_per_unit * req.amount
        return round(total, 2)

    def record_contract(self, requirements: list[ResourceAmount]) -> None:
        """Record a contract fulfillment — reduce rate, balance, and invested proportionally."""
        for req in requirements:
            account = self.accounts[req.resource]
            if account.rate > 0:
                proportion = req.amount / account.rate
                account.balance -= account.balance * proportion
                account.total_invested -= account.total_invested * proportion
                account.total_revenue -= account.total_revenue * proportion
                account.rate -= req.amount

    def snapshot(self) -> dict[str, dict]:
        """Return a snapshot of all accounts for debugging/export."""
        result = {}
        for r, acct in self.accounts.items():
            caps = {}
            for cap_r, cap in self.cap_tables.items():
                for ns in cap.negative_shares:
                    if ns.owner == r:
                        caps[cap_r.value] = round(ns.shares, 2)
            result[r.value] = {
                "rate": acct.rate,
                "balance": round(acct.balance, 2),
                "cost_basis": round(acct.cost_basis, 2),
                "profit": round(acct.profit, 2),
                "liabilities": caps,
            }
        return result

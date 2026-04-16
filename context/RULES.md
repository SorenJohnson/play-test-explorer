# Martian Industries — Game Rules

## Overview
2–4 players compete to build the most valuable industrial empire on Mars. Over the course of several rounds, you'll construct buildings, produce and sell resources, fulfill contracts, and bid on patents. The player with the highest **Net Worth** at the end of the game wins.

**Net Worth = Cash − Debt + Credit**

---

## Setup

1. **Corporations**: Each player is randomly assigned a corporation that provides unique starting production rates.
2. **Starting Cash**: Each player begins with $40.
3. **Market**: The shared resource market opens with tiered prices — basic resources (Power, Water, Iron) start cheap, advanced resources (Glass, Electronics) start expensive.
4. **Hand**: Each player draws 3 building cards.
5. **Building Pool**: 4 building cards are placed face-up in the shared pool.
6. **Contracts**: A set of contracts are placed face-up, available to all players.
7. **Event Deck**: A shuffled deck of event cards determines what happens each turn.

---

## Turn Structure

On your turn, you take these steps in order:

### 1. Pool Swaps (Free)
Swap any number of cards between your hand and the building pool, one at a time. This is free and unlimited — use it to find the cards you need.

### 2. Actions
You have a **budget of 2 cards per turn**. Each action you take spends cards from your hand:

- **Build** (1–2 cards): Play building cards from your hand. Pay the market cost for any resources you need to buy. The building's production rates are permanently added to your board. You may only build once per turn (unless you own Matter Replication).
- **Sell** (1 card): Discard a card to sell resources. You earn your production rate × the current market price. The market price drops by the amount sold.
- **Contract** (1 card): Discard a card with a contract icon to fulfill an available contract. You must have sufficient production rates to meet the contract's requirements. Those rates are permanently spent.

You can mix actions (e.g., build once then sell once) as long as total cards spent ≤ 2. You can also pass without using all your cards.

### 3. Draw
Refill your hand back to 3 cards from the building deck.

### 4. Event
Flip the top card of the event deck and resolve it (see Events below).

---

## Building Cards

Each building card shows:
- **Name** (top)
- **Cost** (top left): Resources you must buy from the market to build it
- **Production Rates** (center): Positive rates = you produce that resource. Negative rates = you consume it (costs you at events)
- **Bottom Action**: Either a **sell action** (lists which resources you can sell with this card) or a **contract icon** (can be used to fulfill contracts)
- **Special buildings**: Most buildings can be built multiple times. Special buildings (those with unique effects like Space Elevator, Launch Pad, etc.) are limited to one copy per player

---

## The Market

The market tracks the price of each resource on a shared price track:

| Price | $1 | $1 | $1 | $2 | $2 | $2 | $3 | $3 | $4 | $4 | $5 | $5 | $6 | $7 | $8 | $9 | $10 |
|-------|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|-----|
| Position | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 |

- **Buying** resources (building) pushes the price **up** by the amount bought
- **Selling** resources pushes the price **down** by the amount sold
- Prices are clamped between $1 and $10

### Starting Prices
| Resource | Price | Color |
|----------|-------|-------|
| Power (PWR) | $2 | Red |
| Water (H2O) | $2 | Dark Blue |
| Iron (FE) | $2 | Grey |
| Carbon (C) | $3 | Purple |
| Silicon (SI) | $3 | Yellow |
| Oxygen (O2) | $4 | White |
| Food (FOOD) | $4 | Green |
| Glass (GLS) | $5 | Light Blue |
| Electronics (ELX) | $5 | Orange |

After setting defaults, each resource is randomly adjusted by a d20 roll at the start of each game.

---

## Contracts

Contracts are available to all players. Each contract lists:
- **Requirements**: Production rates you must permanently give up (e.g., "2 GLS, 1 FOOD")
- **Reward**: $50 cash

When you fulfill a contract:
1. The required rates are permanently removed from your board
2. The $50 reward first **pays off any existing debt**
3. Any leftover becomes **credit** (counts toward net worth and absorbs future debt, but cannot be spent as cash)
4. The fulfilled contract is replaced with a new one from the deck

---

## Events

One event fires at the end of each player's turn:

### Power Bill
Every player's Power (PWR) rate is evaluated:
- **Positive PWR**: You earn rate × market price in cash (you're selling power)
- **Negative PWR**: You gain rate × market price as debt (you're buying power)
- **Zero PWR**: No effect

### Debt Collection
- Players may pay down debt with cash (in $10 increments)
- All debt accrues **interest**: +$1 per $10 of debt
- Credit absorbs interest before it becomes real debt

### Futures Trading
- All players' **negative non-Power rates** push market prices up (simulating demand)
- No debt is charged — this is purely a market adjustment

### Futures Settlement (End of Round / End of Game)
- Players with **negative non-Power rates** pay debt at current market prices
- This is when negative rates actually cost you money

### News Bulletin
A news card is drawn with special effects — rate adjustments, market movements, or triggered events affecting all players.

### Draw Building Card
A new building card is drawn into the pool, replacing the oldest card.

### Patent Auction
A patent card is drawn and all players participate in a silent auction:
- Each player secretly bids (in $5 increments, or $0 to pass)
- Highest bidder wins; pays runner-up's bid + $5 (as debt)
- If tied, lower seat number wins
- If only one bidder, they pay $5
- The winner adds the patent to their buildings

---

## Special Buildings

These unique buildings (one per player) provide powerful abilities:

| Building | Effect |
|----------|--------|
| **Space Elevator** | Once per turn: reduce one contract requirement by 1 |
| **Launch Pad** | Once per turn: fulfill a contract for free (no card cost) |
| **Hacker Array** | When selling: also shift a different resource's market price by ±3 |
| **Optimization Center** | Once per turn: trade −1 Power rate for +1 to any other positive rate |
| **Patent Office** | When built: draw 2 patents, keep 1, return the other |
| **Pleasure Dome** | Passive: earn a bonus on every Power Bill ($20 if 1 dome in game, $15 if 2, $10 if 3+) |

---

## Patents

Patents are special buildings acquired through auctions. They provide unique ongoing abilities:

| Patent | Effect |
|--------|--------|
| **Water Engine** | Once per turn: trade −1 Water rate for +2 Power rate |
| **Teleportation** | Once per turn: free sell of any resource (rate × price), costs −1 Power rate permanently |
| **Matter Replication** | Allows multiple build actions per turn (normally limited to one) |
| **Nanotechnology** | Once per turn: replace one pool card with a fresh draw from the deck |
| **Financial Instruments** | At debt collection: earn cash equal to other players' real debt added this round |
| **Energy Vault** | Shields you from negative Power bills (limited uses based on your Power rate when acquired) |
| **Thinking Machines** | When acquired: draw 1 extra card, permanently increase hand size by 1 |
| **Superconductors** | Adds +1 Power rate (simple but valuable) |

---

## Debt & Credit

- **Debt** is incurred from negative Power rates, futures settlements, and patent auctions
- **Interest**: At each Debt Collection event, debt grows by $1 per $10 owed
- **Credit** comes from contract rewards after paying off debt. It:
  - Counts toward net worth
  - Absorbs future debt before it becomes real
  - Cannot be spent as cash
- **Paying down debt**: At Debt Collection, you can spend cash to pay down debt (in $10 increments)

---

## Game End

The game ends when the final event card (END GAME) is resolved. This triggers:
1. A final Power Bill
2. A final Futures Settlement

Then net worth is calculated for each player:

**Net Worth = Cash − Debt + Credit**

The player with the highest net worth wins.

---

## Strategy Tips

- **Power is king**: Every Power Bill rewards or punishes you. Build positive Power early.
- **Watch the market**: Buying resources pushes prices up for everyone. Selling pushes them down.
- **Contracts get better late**: You permanently lose production rates for $50. Early on, those rates have many turns of earning ahead. Late game, rates have little time left — trading them for $50 is a great deal.
- **Debt is cheap**: Interest is only $1 per $10. Don't be afraid of patent debt if the patent is valuable.
- **Pool swap freely**: The pool is your shop — browse every turn to find the best cards.
- **Special buildings compound**: Launch Pad lets you fulfill contracts without spending a hand card. Space Elevator discounts one contract requirement by 1.

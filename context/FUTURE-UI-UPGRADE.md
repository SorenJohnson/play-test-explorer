# Future Feature: Visual UI Upgrade — Board Animations + Interactive Market

**Status**: Planned for next iteration (v2)
**Saved from**: brainstorm session 2026-04-11

## Summary

Two major UX improvements to make the play interface feel like a real game board:

1. **Board-state animations**: when events fire and players take actions, animate the effects on the actual board elements (flashing money changes, pulsing market columns, sliding cards)
2. **Click-to-sell on market**: when a sell card is selected, market resources glow and become clickable — click the resource you want to sell

## Board-State Animations

| Event | Animation |
|---|---|
| Power Bill | Player money/debt flashes green (earned) or red (paid). PWR column pulses. |
| Debt Collection | Players with debt flash interest. FI owner gets green flash. |
| Futures Settlement | Negative-rate resources pulse red on affected players. |
| Patent Auction | Winner's patent section glows. Losing bids fade. |
| News Bulletin | Affected market columns pulse green/red. |
| Draw Building Card | New pool card slides in. Evicted card fades out. |
| Build | Cards slide from hand to buildings list. Money ticks down. |
| Sell | Resource amount flies from player panel to market column. Money ticks up. |
| Contract | Rates flash, reward flies to money/credit. |
| END_ROUND / END_GAME | Full-board dim + centered overlay text. |

Implementation: CSS `@keyframes` + JS class toggling via `boardAnimate(type, data)`. No external libraries. Sequential queue for AI turns, instant for human.

## Interactive Market Selling

When a sell card is selected, sellable resource columns get a glow border + "Sell X for $Y" hint. Click to execute. Non-sellable resources stay dim.

## Quick Wins (bundle with v2)

- Simplify action hints from 11 states to 4
- Responsive market grid (wraps on small screens instead of overflow)
- Contract badges showing how many hand cards can fulfill each contract
- Group special toggles (SE/LP/HA/Discard-2) under clear headings

## Technical Notes

- Purely frontend changes — no backend modifications needed
- CSS animations keep it lightweight (no canvas/WebGL)
- Animation queue prevents AI turn animations from overlapping
- Market click handlers coexist with the existing resource picker (picker becomes fallback)

# Design Document

## Problem

I am researching the balance and impact of a board game prototype

## Approach

I am interested in creating static website javascript based visualizations to help with explore the impact of different design choices in the board game. Particularly around card choice and costs.

## Data Model

The basic premise of this flow is there are cards. Cards have a cost and rate. The rate is the permenant "improvement" the player recieves and it can be used to pay the cost of future cards. The cost is how much of a rate you need to play the building. If you do not have the rate then you have to buy if from the market. After you purchase from the market the market price goes up.

Cards also have an ability to sell the quantity of the rate you have to the market. Selling doesn't change the rates you produce it just allowed you to convert a card into currency, which can then be used to buy from the market so you can build things that you do not have the rate for. "Alternate" indidcates what the card can be sold for. For H20/FE means you can sell your rate of H20 or FE with that card instead of building with that card. When you sell with a card the market price goes down the quantity you sold for.

Negative rates do not effect purchase price. If you need 2 FE to build, you can buy 2 FE at the current market price, being negative has no impact on that. But if you are positve 1 FE then you only need to purhcase 1 FE from the market.

The goal of the game is to have the most money, you get moeny from selling but you also get money from filling contracts. Filling contracts requires you to spend a card that has the contract option (or spend two cards) but also requires you to spend your rates. So a contract costs you your rates permentantly, but they are worth 50 gold. Selling you gain gold for your rate amounts at current market price, contracts you spend your rates and earn the contract.


## Open Questions

I want to visualize this game, particularly the cards. I want to get some sense of what a contract costs. Contracts can only be filled by having 

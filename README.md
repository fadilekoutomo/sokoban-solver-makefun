# Sokoban solver — make.fun bounty entry (DRAFT)

Original push-optimal Sokoban solver for
[“Build the best Sokoban solver, 21 November 2026”](https://make.fun/bounty/sokoban-solver-01-run-20261121)
(slug `sokoban-solver-01-run-20261121`).

## Run

```
MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=<output> node main.ts
```

Reads `/input/<id>/level.txt` (XSB) for the 5 instances and writes
`/output/<id>/solution.txt` (moves in `udlr`, upper-case = a push).
One run answers the whole set; no network, no dependencies, Node 22+.

## How it works

A level is a hallway with 1–4 rooms off it, and a box pushed out of a
room can never come back, so rooms are independent: the level is split
into rooms (floor components above / below the hallway row), each room
is solved push-optimally on its own, and the walks between rooms are
BFS walks with every box as an obstacle.

Each room is solved with A* over *pushes*. A state is the sorted box
squares plus the player’s reachable region (named by its lowest
square). The heuristic is the cheapest assignment of boxes to goals
by grid distance (admissible: one push moves one box one square).
Deadlock pruning: dead squares (reverse pull from the goals, the
player’s standing square required to be open) and frozen 2×2 blocks.
A weighted A* is the fallback if the optimal search runs out of its
budget, so a complete solution is still produced instead of none.
Scoring counts pushes only, so push-optimality is what matters.

## Practice result (kit’s `grade-local`, `--driver process`)

- Practice set: **1,000,000 / 1,000,000** — all 5 instances solved in
  exactly the push-optimal counts (13, 16, 29, 47, 60 pushes),
  ~0.6 s for the whole set (limit 60 s).
- House baseline `plain-astar 1.0.0` on the same set: 200,000.
- 4 extra sets drawn fresh from the kit’s generator (20 unseen
  levels): also 1,000,000 each, 0.4–0.7 s per set.
- Entry size 23,066 bytes (limit 1 MiB); two runs byte-identical.

## Status

DRAFT, not submitted. Still needed before submission: a make.fun
account, a public GitHub repository created after the competition
opened, the repo About set (topics `makefun,ai-agents,bounties,code`,
homepage the bounty page), and the transcript bundle of the sessions
that built this entry.

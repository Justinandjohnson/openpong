import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nameRank,
  nameVariants,
  type PlayerCandidate,
  playerCandidates,
  rankCandidates,
} from "../apps/server/src/engine/service.ts";

/**
 * The local player index stores names as "Last, First", so someone typing
 * their own name the normal way has to still find themselves.
 */

test("a name is tried both ways round", () => {
  assert.deepEqual(nameVariants("Amy Wang"), ["Amy Wang", "Wang, Amy"]);
  assert.deepEqual(nameVariants("Wang, Amy"), ["Wang, Amy", "Amy Wang"]);
  assert.deepEqual(nameVariants("Wang"), ["Wang"]);
  assert.deepEqual(nameVariants("  Amy   Wang  "), ["Amy Wang", "Wang, Amy"]);
  // Three parts: "Aaron Mingran Wang" is stored as "Wang, Aaron Mingran".
  assert.deepEqual(nameVariants("Aaron Mingran Wang"), [
    "Aaron Mingran Wang",
    "Wang, Aaron Mingran",
    "Mingran Wang, Aaron",
  ]);
});

test("a blank name has nothing to try", () => {
  assert.deepEqual(nameVariants("   "), []);
});

test("ranking prefers every word, in order, then scrambled, then partial", () => {
  const amy: PlayerCandidate = { name: "Wang, Amy", rating: 2568 };
  const david: PlayerCandidate = { name: "Wang, David", rating: 1624 };
  const unrelated: PlayerCandidate = { name: "Chen, Han", rating: 1238 };

  assert.equal(nameRank(amy, "Wang Amy"), 0);
  // Typing "First Last" against a "Last, First" index is every word, scrambled.
  assert.equal(nameRank(amy, "Amy Wang"), 1);
  assert.equal(nameRank(david, "Amy Wang"), 2);
  assert.equal(nameRank(unrelated, "Amy Wang"), 3);
});

test("a short token is not treated as a prefix", () => {
  const bobby: PlayerCandidate = { name: "Bobby, Lee" };
  // "Bo" must not match "Bobby"; three characters or more may.
  assert.equal(nameRank(bobby, "Bo"), 3);
  assert.equal(nameRank(bobby, "Bob"), 0);
});

test("the best answer comes first and unrelated rows are dropped", () => {
  const rows: PlayerCandidate[] = [
    { name: "Wang, David", rating: 1624, state: "TX" },
    { name: "Chen, Han", rating: 1238 },
    { name: "Wang, Amy", rating: 2568, state: "NJ" },
  ];
  const ranked = rankCandidates(rows, "Amy Wang");
  assert.equal(ranked[0].name, "Wang, Amy");
  assert.equal(ranked.length, 2, "the unrelated player is not offered");
});

test("when nothing matches, nothing is invented", () => {
  const rows: PlayerCandidate[] = [{ name: "Chen, Han", rating: 1238 }];
  assert.deepEqual(rankCandidates(rows, "Nobody Here"), rows);
  assert.deepEqual(rankCandidates([], "Amy Wang"), []);
});

test("the strongest rating breaks a tie between equally good answers", () => {
  const rows: PlayerCandidate[] = [
    { name: "Wang, Amy", rating: 1200, state: "TX" },
    { name: "Wang, Amy", rating: 2568, state: "NJ" },
  ];
  const ranked = rankCandidates(rows, "Amy Wang");
  assert.equal(ranked[0].rating, 2568);
});

test("the live index replaces a stale cache row for the same person", () => {
  const cached: PlayerCandidate[] = [{ name: "Wang, Amy", rating: 2568, state: "NJ" }];
  const live: PlayerCandidate[] = [
    { name: "Wang, Amy", rating: 2556, state: "NJ", usattId: "76235", source: "usatt" },
  ];
  // Order of the sources must not matter.
  assert.deepEqual(playerCandidates(cached, live), live);
  assert.deepEqual(playerCandidates(live, cached), live);
});

test("two different people with the same words in a different order stay separate", () => {
  const rows: PlayerCandidate[] = [
    { name: "Wang, Amy", rating: 2556, usattId: "1", source: "usatt" },
    { name: "Amy, Wang", rating: 1200, usattId: "2", source: "usatt" },
  ];
  // Same two words, so the second replaces the first rather than duplicating.
  assert.equal(playerCandidates(...rows).length, 1);
  const distinct: PlayerCandidate[] = [
    { name: "Wang, Amy", rating: 2556, usattId: "1", source: "usatt" },
    { name: "Wang, Wei", rating: 2620, usattId: "3", source: "usatt" },
  ];
  assert.equal(playerCandidates(...distinct).length, 2);
});

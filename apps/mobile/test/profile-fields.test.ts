import assert from "node:assert/strict";
import test from "node:test";
import type { OwnerProfile } from "../../../packages/domain/src/agent.ts";
import {
  draftComplete,
  draftFromProfile,
  emptyDraft,
  joinList,
  normalizeLeagueUrl,
  profileInputFromDraft,
  showValue,
  splitList,
} from "../src/profile-fields.ts";

const profile: OwnerProfile = {
  id: "profile",
  updatedAt: "2026-01-01T00:00:00.000Z",
  displayName: "Example Person",
  usattId: "1234567",
  homeRegion: "8",
  cities: ["Springfield", "Shelbyville"],
  states: ["Ohio"],
  clubs: ["Example Table Tennis Club"],
  leagueUrls: ["https://stadiumtt.com/tournament/example"],
};

test("list fields split on commas and new lines, trim, and drop duplicates", () => {
  assert.deepEqual(splitList(" Springfield ,  Shelbyville\nSpringfield "), [
    "Springfield",
    "Shelbyville",
  ]);
  assert.deepEqual(splitList(""), []);
  assert.deepEqual(splitList(" , \n "), []);
});

test("a URL without a scheme gets https:// and a real one is left alone", () => {
  assert.equal(normalizeLeagueUrl("stadiumtt.com"), "https://stadiumtt.com");
  assert.equal(
    normalizeLeagueUrl("https://stadiumtt.com/tournament/x"),
    "https://stadiumtt.com/tournament/x",
  );
  assert.equal(normalizeLeagueUrl("   "), "");
});

test("the draft round-trips a saved profile exactly", () => {
  const draft = draftFromProfile(profile);
  assert.equal(draft.displayName, "Example Person");
  assert.equal(draft.cities, "Springfield, Shelbyville");
  assert.equal(draft.leagueUrls, "https://stadiumtt.com/tournament/example");
  const input = profileInputFromDraft(draft);
  assert.deepEqual(input, {
    displayName: "Example Person",
    usattId: "1234567",
    homeRegion: "8",
    cities: ["Springfield", "Shelbyville"],
    states: ["Ohio"],
    clubs: ["Example Table Tennis Club"],
    leagueUrls: ["https://stadiumtt.com/tournament/example"],
  });
});

test("blank optional fields are omitted, not saved as empty settings", () => {
  const input = profileInputFromDraft({ ...emptyDraft(), displayName: "  Someone  " });
  assert.deepEqual(input, { displayName: "Someone" });
});

test("a first-run draft is empty and incomplete until a name is entered", () => {
  const draft = emptyDraft();
  assert.equal(draftComplete(draft), false);
  assert.equal(draftComplete({ ...draft, displayName: "   " }), false);
  assert.equal(draftComplete({ ...draft, displayName: "Someone" }), true);
});

test("the settings summary shows values and a clear empty state", () => {
  assert.equal(showValue("Ohio"), "Ohio");
  assert.equal(showValue(["Springfield", "Shelbyville"]), "Springfield, Shelbyville");
  assert.equal(showValue(undefined), "Not set yet");
  assert.equal(showValue("   "), "Not set yet");
  assert.equal(joinList(undefined), "");
});

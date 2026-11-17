import type { OwnerProfile, OwnerProfileInput } from "../../../packages/domain/src/agent.ts";

/**
 * The editable text form of the owner profile. Every field is a string while
 * the person types; `profileInputFromDraft` turns it back into the validated
 * shape the server expects. No value here is a default identity: an empty
 * draft is the first-run state.
 */
export interface ProfileDraft {
  displayName: string;
  usattId: string;
  homeRegion: string;
  cities: string;
  states: string;
  clubs: string;
  leagueUrls: string;
}

export function emptyDraft(): ProfileDraft {
  return {
    displayName: "",
    usattId: "",
    homeRegion: "",
    cities: "",
    states: "",
    clubs: "",
    leagueUrls: "",
  };
}

/** Split a typed list on commas and new lines, dropping blanks and duplicates. */
export function splitList(text: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const part of text.split(/[,\n]+/)) {
    const value = part.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

/** A list rendered for a one-line field. */
export function joinList(values: string[] | undefined): string {
  return (values ?? []).join(", ");
}

/** URLs rendered for a multi-line field, one per line. */
export function joinLines(values: string[] | undefined): string {
  return (values ?? []).join("\n");
}

/** Accept "stadiumtt.com/..." and store "https://stadiumtt.com/...". */
export function normalizeLeagueUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function draftFromProfile(profile: OwnerProfile | null | undefined): ProfileDraft {
  if (!profile) return emptyDraft();
  return {
    displayName: profile.displayName ?? "",
    usattId: profile.usattId ?? "",
    homeRegion: profile.homeRegion ?? "",
    cities: joinList(profile.cities),
    states: joinList(profile.states),
    clubs: joinList(profile.clubs),
    leagueUrls: joinLines(profile.leagueUrls),
  };
}

/**
 * The payload for `PUT /api/agent/profile`. Blank optional fields are omitted
 * rather than saved as empty strings, and a league URL without a scheme gets
 * one so a typed domain is accepted.
 */
export function profileInputFromDraft(draft: ProfileDraft): OwnerProfileInput {
  const text = draft.displayName.trim();
  const optional = (value: string) => {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };
  const list = (value: string) => {
    const values = splitList(value);
    return values.length ? values : undefined;
  };
  const usattId = optional(draft.usattId);
  const homeRegion = optional(draft.homeRegion);
  const cities = list(draft.cities);
  const states = list(draft.states);
  const clubs = list(draft.clubs);
  const leagueUrls = splitList(draft.leagueUrls).map(normalizeLeagueUrl).filter(Boolean);
  // Only fields the person filled in are sent, so a blank input never becomes a setting.
  return {
    displayName: text,
    ...(usattId ? { usattId } : {}),
    ...(homeRegion ? { homeRegion } : {}),
    ...(cities ? { cities } : {}),
    ...(states ? { states } : {}),
    ...(clubs ? { clubs } : {}),
    ...(leagueUrls.length ? { leagueUrls } : {}),
  };
}

/** Only a name is required to onboard. */
export function draftComplete(draft: ProfileDraft): boolean {
  return Boolean(draft.displayName.trim());
}

/** "Not set yet" for a value the person has not entered. */
export function showValue(value: string | string[] | undefined): string {
  const text = Array.isArray(value) ? joinList(value) : (value ?? "").trim();
  return text || "Not set yet";
}

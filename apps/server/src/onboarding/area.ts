import type { OwnerProfileInput } from "../../../../packages/domain/src/agent.ts";

/**
 * The owner's area, resolved from their profile. Nothing here is a literal:
 * an owner with no area config gets an empty area, so the table-tennis tools
 * fall back to whatever the OmniPong service itself is configured for instead
 * of a region baked into this server.
 */
export interface TournamentArea {
  region?: string;
  cities: string[];
  states: string[];
}

export function areaFor(profile: OwnerProfileInput | null | undefined): TournamentArea {
  const clean = (values: string[] | undefined) =>
    (values ?? []).map((value) => value.trim()).filter(Boolean);
  const region = profile?.homeRegion?.trim();
  return {
    ...(region ? { region } : {}),
    cities: clean(profile?.cities),
    states: clean(profile?.states),
  };
}

/**
 * The region passed to the tournament list: an explicit tool argument wins,
 * then the profile's home region, then nothing at all. Passing nothing omits
 * the query parameter so the service uses its own configuration — this server
 * never substitutes a "local" or regional default of its own.
 */
export function resolveTournamentRegion(
  requested: string | undefined,
  area: TournamentArea,
): string | undefined {
  const explicit = requested?.trim();
  return explicit || area.region || undefined;
}

/** The human label for a monitor or notification, e.g. "Region 8" or "your area". */
export function areaLabel(area: TournamentArea): string {
  return area.region ? `${area.region} area` : "your area";
}

/** Location text a tournament row carries; every recognized shape, lowercased. */
function locationsOf(row: Record<string, unknown>): string[] {
  const values = [row.location, row.city_state, row.city, row.state, row.venue]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.toLowerCase());
  return values;
}

/** US state names and abbreviations, so a profile's "Ohio" matches a listing's "OH". */
const stateNames =
  "AL:Alabama,AK:Alaska,AZ:Arizona,AR:Arkansas,CA:California,CO:Colorado,CT:Connecticut,DE:Delaware,DC:District of Columbia,FL:Florida,GA:Georgia,HI:Hawaii,ID:Idaho,IL:Illinois,IN:Indiana,IA:Iowa,KS:Kansas,KY:Kentucky,LA:Louisiana,ME:Maine,MD:Maryland,MA:Massachusetts,MI:Michigan,MN:Minnesota,MS:Mississippi,MO:Missouri,MT:Montana,NE:Nebraska,NV:Nevada,NH:New Hampshire,NJ:New Jersey,NM:New Mexico,NY:New York,NC:North Carolina,ND:North Dakota,OH:Ohio,OK:Oklahoma,OR:Oregon,PA:Pennsylvania,RI:Rhode Island,SC:South Carolina,SD:South Dakota,TN:Tennessee,TX:Texas,UT:Utah,VT:Vermont,VA:Virginia,WA:Washington,WV:West Virginia,WI:Wisconsin,WY:Wyoming";
const stateAliases = new Map<string, string[]>();
for (const entry of stateNames.split(",")) {
  const [abbreviation, name] = entry.split(":");
  if (!abbreviation || !name) continue;
  const variants = [abbreviation.toLowerCase(), name.toLowerCase()];
  stateAliases.set(abbreviation.toLowerCase(), variants);
  stateAliases.set(name.toLowerCase(), variants);
}

/** A profile's state is matched as both its name and its abbreviation ("Ohio" ↔ "OH"). */
function stateVariants(state: string): string[] {
  const value = state.trim().toLowerCase();
  return stateAliases.get(value) ?? [value];
}

function matchesStates(text: string, states: string[]): boolean {
  return states.some((state) =>
    stateVariants(state).some((needle) => {
      // A two-letter abbreviation must be its own token: "in" must not match "Minneapolis".
      if (needle.length <= 2) return new RegExp(`(^|[^a-z])${needle}([^a-z]|$)`).test(text);
      return text.includes(needle);
    }),
  );
}

/**
 * Narrow the service's list to the owner's cities/states when the profile
 * defines an area. Deliberately soft: if the profile's words match none of the
 * returned rows (different spellings, a service-side area filter that already
 * applies), the full list is returned so an unusual data shape never hides
 * tournaments from the owner.
 */
export function narrowTournaments<T extends Record<string, unknown>>(
  rows: T[],
  area: TournamentArea,
): T[] {
  if (!area.cities.length && !area.states.length) return rows;
  const cities = area.cities.map((city) => city.toLowerCase());
  const matched = rows.filter((row) => {
    const text = locationsOf(row).join(" | ");
    if (!text) return false;
    return cities.some((city) => text.includes(city)) || matchesStates(text, area.states);
  });
  return matched.length ? matched : rows;
}

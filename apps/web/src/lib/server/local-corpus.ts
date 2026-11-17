import "server-only";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { OMNIPONG_DB_PATH } from "./openpong";

/**
 * Read-only view of the local OmniPong corpus.
 *
 * The running Python service is always preferred (see the BFF route). This module
 * is the graceful fallback for a first run where the service is pointed at an empty
 * demo database but the owner's synced corpus already exists on disk. It never
 * writes, and it is disabled entirely unless a database file is found.
 */

type Row = Record<string, unknown>;

function findDb(): string | undefined {
  const candidates = [
    OMNIPONG_DB_PATH,
    resolve(process.cwd(), "omnipong.db"),
    resolve(process.cwd(), "../../services/omnipong/omnipong.db"),
    resolve(process.cwd(), "../services/omnipong/omnipong.db"),
    join(homedir(), "Desktop/omnipong/omnipong.db"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Ignore an unreadable candidate and keep looking.
    }
  }
  return undefined;
}

let database: unknown;
let attempted = false;

async function db(): Promise<any | null> {
  if (!attempted) {
    attempted = true;
    const path = findDb();
    if (!path) return null;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      database = new DatabaseSync(path, { readOnly: true });
    } catch (error) {
      console.warn(
        "[openpong] local corpus unavailable:",
        error instanceof Error ? error.message : error,
      );
      database = null;
    }
  }
  return database ?? null;
}

function all(statement: any, params: unknown[] = []): Row[] {
  return (statement.all(...params) as Row[]).map((row) => ({ ...row }));
}

function isWin(result: unknown): boolean {
  if (result === "Win" || result === "W") return true;
  if (result === "Loss" || result === "L") return false;
  if (typeof result === "string" && result.includes("-")) {
    const [a, b] = result.split("-").map((part) => Number.parseInt(part, 10));
    return Number.isFinite(a) && Number.isFinite(b) ? a > b : false;
  }
  return false;
}

function matchFlags(match: Row): Row {
  const result = match.result;
  const sets = typeof match.set_scores === "string" ? match.set_scores : "";
  let isClose = false;
  const parsed: [number, number][] = [];
  for (const raw of sets.split(",")) {
    const [a, b] = raw.split("-").map((part) => Number.parseInt(part.trim(), 10));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      parsed.push([a, b]);
      if (Math.abs(a - b) <= 2) isClose = true;
    }
  }
  const wonFirst = parsed.length > 0 ? parsed[0][0] > parsed[0][1] : false;
  const won = isWin(result);
  return {
    ...match,
    is_win: won,
    is_comeback: won && !wonFirst,
    is_choke: !won && wonFirst,
    is_close_game: isClose,
  };
}

const sourceFilter = (source?: string | null): { clause: string; params: unknown[] } => {
  if (source === "usatt" || source === "omnipong")
    return { clause: "source = 'omnipong'", params: [] };
  if (source === "arcade") return { clause: "source = 'arcade'", params: [] };
  if (source === "stadium") return { clause: "source = 'stadium'", params: [] };
  if (source === "stadium_league") return { clause: "source = 'stadium_league'", params: [] };
  if (source) return { clause: "source = ?", params: [source] };
  return { clause: "", params: [] };
};

export async function localUser(): Promise<Row | null> {
  const connection = await db();
  if (!connection) return null;
  try {
    const row = all(
      connection.prepare(
        "SELECT name AS full_name, current_rating AS rating, usatt_id AS usatt_number, phone_number FROM users LIMIT 1",
      ),
    )[0];
    return row ?? null;
  } catch {
    return null;
  }
}

export async function localMatches(source?: string | null): Promise<Row[]> {
  const connection = await db();
  if (!connection) return [];
  try {
    const filter = sourceFilter(source);
    const sql = `SELECT id, date, opponent_name, opponent_rating, score_summary, result, source, set_scores FROM matches ${
      filter.clause ? `WHERE ${filter.clause}` : ""
    } ORDER BY date DESC`;
    return all(connection.prepare(sql), filter.params).map(matchFlags);
  } catch {
    return [];
  }
}

export async function localMatchSummary(source?: string | null): Promise<Row | null> {
  const matches = await localMatches(source);
  if (!matches.length) return null;
  const buckets = new Map<
    string,
    { year: string; wins: number; losses: number; dates: Set<string>; matches: Row[] }
  >();
  for (const match of matches) {
    const year = match.date ? String(match.date).slice(0, 4) : "Unknown";
    const bucket = buckets.get(year) ?? {
      year,
      wins: 0,
      losses: 0,
      dates: new Set<string>(),
      matches: [],
    };
    if (match.is_win) bucket.wins += 1;
    else bucket.losses += 1;
    if (match.date) bucket.dates.add(String(match.date).slice(0, 10));
    bucket.matches.push(match);
    buckets.set(year, bucket);
  }
  const years = [...buckets.values()]
    .sort((a, b) => b.year.localeCompare(a.year))
    .map((bucket) => {
      const total = bucket.wins + bucket.losses;
      return {
        year: bucket.year,
        total,
        wins: bucket.wins,
        losses: bucket.losses,
        win_rate: total ? Math.round((bucket.wins / total) * 100) : 0,
        tournaments: bucket.dates.size,
        matches: bucket.matches,
      };
    });
  const wins = matches.filter((m) => m.is_win).length;
  return {
    overall: {
      total: matches.length,
      wins,
      losses: matches.length - wins,
      win_rate: matches.length ? Math.round((wins / matches.length) * 100) : 0,
    },
    years,
  };
}

export async function localRatingHistory(source?: string | null): Promise<Row[]> {
  const connection = await db();
  if (!connection) return [];
  try {
    const filter = sourceFilter(source);
    const sql = `SELECT date, rating, notes FROM rating_history ${
      filter.clause ? `WHERE ${filter.clause}` : ""
    } ORDER BY date ASC`;
    return all(connection.prepare(sql), filter.params);
  } catch {
    return [];
  }
}

export async function localStats(source?: string | null): Promise<Row | null> {
  const matches = await localMatches(source);
  if (!matches.length) return null;
  const wins = matches.filter((match) => match.is_win).length;
  const losses = matches.length - wins;
  const history = await localRatingHistory(source);
  const latest = history.at(-1)?.rating;
  const previous = history.at(-2)?.rating;
  const trend =
    typeof latest === "number" && typeof previous === "number"
      ? `${latest - previous >= 0 ? "+" : ""}${latest - previous}`
      : "—";
  const comebacks = matches.filter((match) => match.is_comeback).length;
  const chokes = matches.filter((match) => match.is_choke).length;
  const close = matches.filter((match) => match.is_close_game).length;
  const dates = new Set(matches.map((match) => String(match.date).slice(0, 10)));
  return {
    win_rate: `${Math.round((wins / matches.length) * 100)}%`,
    wins,
    losses,
    tournaments: String(dates.size),
    trend,
    rating_context:
      source === "usatt" || source === "omnipong"
        ? "USATT Official"
        : source === "arcade"
          ? "Arcade Mode"
          : "Club League",
    patterns: {
      comebacks,
      chokes,
      close_game_win_rate: matches.length ? Math.round((close / matches.length) * 100) : 0,
    },
  };
}

export async function localTournaments(region?: string | null): Promise<Row[]> {
  const connection = await db();
  if (!connection) return [];
  try {
    const rows = all(
      connection.prepare(
        "SELECT title, location, city_state, date_range, status, flyer_url, source_id, url, contact_email, last_scraped FROM activities WHERE activity_type = 'tournament' ORDER BY id DESC",
      ),
    );
    return rows.map((row) => {
      const sourceId = typeof row.source_id === "string" ? row.source_id.trim() : "";
      const omnipongUrl =
        sourceId && !sourceId.toLowerCase().startsWith("http")
          ? `https://www.omnipong.com/${sourceId.replace(/^\/+/, "")}`
          : typeof row.url === "string" && row.url
            ? row.url
            : "https://www.omnipong.com/t-tourney.asp?e=0";
      return { ...row, omnipong_url: omnipongUrl, estimated_cost: null, events: null, tier: null };
    });
    // `region` is intentionally not applied here: the area filter lives in the
    // OmniPong service (per-deployment config), never as a literal in this app.
  } catch {
    return [];
  }
}

export async function localNotifications(): Promise<Row[]> {
  const connection = await db();
  if (!connection) return [];
  try {
    return all(
      connection.prepare(
        "SELECT id, type, content, is_read, created_at FROM notifications WHERE is_read = 0 ORDER BY created_at DESC",
      ),
    ).map((row) => {
      if (typeof row.content === "string") {
        try {
          return { ...row, content: JSON.parse(row.content) };
        } catch {
          return row;
        }
      }
      return row;
    });
  } catch {
    return [];
  }
}

export async function localSearchPlayers(name: string): Promise<Row[]> {
  const connection = await db();
  if (!connection) return [];
  try {
    const normalized = name.trim();
    const rows = all(
      connection.prepare(
        "SELECT name, usatt_id, rating, state FROM players WHERE name LIKE ? OR usatt_id = ?",
      ),
      [`%${normalized}%`, normalized],
    );
    if (rows.length) return rows;
    return all(
      connection.prepare(
        "SELECT DISTINCT opponent_name AS name, opponent_usatt_id AS usatt_id, opponent_rating AS rating FROM matches WHERE opponent_name LIKE ? AND opponent_rating IS NOT NULL",
      ),
      [`%${normalized}%`],
    );
  } catch {
    return [];
  }
}

export async function localDatabasePath(): Promise<string | undefined> {
  await db();
  return findDb();
}

export const databaseDirectory = () => dirname(findDb() ?? "");

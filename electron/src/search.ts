import { sessionLabel } from "./session-label.ts";
import type { DatabaseSync } from "node:sqlite";
import { prepare, type Statement } from "./database.ts";
import type {
  Filter,
  StoredEvent,
  EventPosition,
  EventRow,
  HistoryStatus,
  NavigationRequest,
  Navigation,
  Reply,
  ChoiceField,
  Direction,
} from "./types.ts";
import { MAX_PAYLOAD_BYTES } from "./recording.ts";

const QUERY_LIMITS = Object.freeze({
  text: 512,
  hooks: 32,
  filterBytes: 128 * 1024,
  choiceCount: 32,
  choiceBytes: 128 * 1024,
  deadlineMs: 250,
  ticks: 64,
});
const metadata = [
  "hook",
  "session",
  "tool",
  "receivedAt",
  "localReceivedAt",
  "connectionId",
  "sequence",
  "bytes",
  "model",
  "command",
  "responseBytes",
] as const;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
const strings = (value: unknown, nullable = false): boolean =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (v) =>
        (nullable && v === null) ||
        (typeof v === "string" && v.length <= MAX_PAYLOAD_BYTES && v.isWellFormed()),
    ));
function validFilter(value: unknown): value is Filter {
  const filter = value as Filter | null;
  return !!(
    filter &&
    typeof filter.text === "string" &&
    filter.text.length <= QUERY_LIMITS.text &&
    filter.text.isWellFormed() &&
    (filter.session === null ||
      (typeof filter.session === "string" &&
        filter.session.length <= MAX_PAYLOAD_BYTES &&
        filter.session.isWellFormed())) &&
    Array.isArray(filter.hooks) &&
    filter.hooks.length <= QUERY_LIMITS.hooks &&
    filter.hooks.every(
      (value) =>
        typeof value === "string" && value.length <= MAX_PAYLOAD_BYTES && value.isWellFormed(),
    ) &&
    strings(filter.sessions) &&
    strings(filter.tools) &&
    strings(filter.models, true) &&
    (filter.prefix === undefined ||
      (typeof filter.prefix === "string" &&
        filter.prefix.length <= QUERY_LIMITS.text &&
        filter.prefix.isWellFormed())) &&
    (filter.minimumBytes == null ||
      (typeof filter.minimumBytes === "number" &&
        Number.isFinite(filter.minimumBytes) &&
        filter.minimumBytes >= 0 &&
        filter.minimumBytes <= Number.MAX_SAFE_INTEGER)) &&
    (filter.unknownBytes === undefined || typeof filter.unknownBytes === "boolean") &&
    (filter.sort === undefined || filter.sort === "newest" || filter.sort === "largest") &&
    Buffer.byteLength(JSON.stringify(filter)) <= QUERY_LIMITS.filterBytes
  );
}
function matches(event: Partial<StoredEvent>, filter: Filter) {
  if (filter.session !== null && event.session !== filter.session) return false;
  if (filter.hooks.length && !filter.hooks.includes(event.hook ?? "")) return false;
  if (filter.sessions?.length && !filter.sessions.includes(event.session ?? "")) return false;
  if (filter.tools?.length && !filter.tools.includes(event.tool ?? "")) return false;
  if (filter.models?.length && !filter.models.includes(event.model ?? null)) return false;
  if (filter.prefix && !event.command?.startsWith(filter.prefix)) return false;
  if (filter.minimumBytes != null || filter.unknownBytes) {
    if (
      event.responseBytes == null
        ? !filter.unknownBytes
        : filter.minimumBytes == null || event.responseBytes <= filter.minimumBytes
    )
      return false;
  }
  if (!filter.text) return true;
  return [event.text, ...metadata.map((key) => event[key])].some(
    (value) => value != null && String(value).toLowerCase().includes(filter.text),
  );
}
class QueryStopped extends Error {
  stale: boolean;
  constructor(stale = false) {
    super(stale ? "Query canceled." : "Search timed out. Narrow the query or Reset filters.");
    this.stale = stale;
  }
}

interface Queries {
  count: Statement<{ count: number; responseBytes: number; measuredCalls: number }>;
  rank: Statement<{ count: number }>;
  at: Statement<StoredEvent | (EventPosition & { text?: never })>;
  previous: Statement<StoredEvent | (EventPosition & { text?: never })>;
  next: Statement<StoredEvent | (EventPosition & { text?: never })>;
  before: Statement<EventRow>;
  after: Statement<EventRow>;
}
class Search {
  database: DatabaseSync;
  shared: Int32Array;
  queryId: number;
  maximumMs: number;
  canceled: number;
  timeouts: number;
  generation = 0;
  targetId = 0;
  deadline = 0;
  filter: Filter = { text: "", session: null, hooks: [] };
  recordingFirst = false;
  firstMatch: EventPosition | null = null;
  count: number | null = null;
  arrivals = 0;
  responseBytes = 0;
  measuredCalls = 0;
  removed = 0;
  queries: Queries[];
  sql!: Queries;
  choiceQueries: Record<ChoiceField, Record<"first" | Direction, Statement<{ value: string }>>>;
  choiceText = "";
  choiceDeadline = Infinity;
  sessionContext: Statement<{ context: string }>;
  constructor(database: DatabaseSync, shared: Int32Array) {
    this.database = database;
    this.sessionContext = prepare(
      database,
      "SELECT context FROM events WHERE session = ? AND context IS NOT NULL ORDER BY id DESC LIMIT 1",
    );
    this.shared = shared;
    this.queryId = 0;
    this.maximumMs = 0;
    this.canceled = 0;
    this.timeouts = 0;
    database.function(
      "scope_matches",
      (
        id,
        text,
        hook,
        session,
        tool,
        receivedAt,
        localReceivedAt,
        connectionId,
        sequence,
        bytes,
        model,
        command,
        responseBytes,
      ) => {
        this.check();
        const event = {
          text,
          hook,
          session,
          tool,
          receivedAt,
          localReceivedAt,
          connectionId,
          sequence,
          bytes,
          model,
          command,
          responseBytes,
        } as Partial<StoredEvent>;
        const matched = matches(event, this.filter);
        if (matched && this.recordingFirst && (!this.firstMatch || Number(id) < this.firstMatch.id))
          this.firstMatch = { id: Number(id), receivedAt: String(receivedAt) };
        return Number(matched);
      },
    );
    this.queries = [undefined, "newest", "largest"].flatMap((sort) =>
      [false, true].map((text) => {
        const match = `scope_matches(id,${text ? "text" : "NULL"},${metadata.join(",")})`;
        const columns =
          "id, receivedAt, substr(hook,1,160) AS hook, substr(session,1,160) AS session, substr(tool,1,160) AS tool, substr(model,1,160) AS model, responseBytes, context, preview";
        const order =
          sort === "largest"
            ? "COALESCE(responseBytes,-1) DESC, id DESC"
            : sort === "newest"
              ? "id DESC"
              : "id";
        const reverse =
          sort === "largest"
            ? "COALESCE(responseBytes,-1), id"
            : sort === "newest"
              ? "id"
              : "id DESC";
        const comparison = sort === "largest" ? "(COALESCE(responseBytes,-1),id)" : "id";
        const bound =
          sort === "largest"
            ? "(COALESCE((SELECT responseBytes FROM events WHERE id=?),-1),?)"
            : "?";
        const before = `${comparison} ${sort ? ">" : "<"} ${bound}`;
        const after = `${comparison} ${sort ? "<=" : ">="} ${bound}`;
        return {
          count: prepare(
            database,
            `SELECT count(*) AS count, COALESCE(sum(responseBytes),0) AS responseBytes, count(responseBytes) AS measuredCalls FROM events WHERE id <= ? AND ${match}`,
          ),
          rank: prepare(
            database,
            `SELECT count(*) AS count FROM events WHERE ${before} AND id <= ? AND ${match}`,
          ),
          at: prepare(
            database,
            `SELECT ${sort ? "id,receivedAt" : "*"} FROM events WHERE id = (SELECT id FROM events WHERE id <= ? AND ${match} ORDER BY ${order} LIMIT 1 OFFSET ?)`,
          ),
          before: prepare(
            database,
            `SELECT ${columns} FROM events WHERE ${before} AND id <= ? AND ${match} ORDER BY ${reverse} LIMIT ?`,
          ),
          after: prepare(
            database,
            `SELECT ${columns} FROM events WHERE ${after} AND id <= ? AND ${match} ORDER BY ${order} LIMIT ?`,
          ),
          previous: prepare(
            database,
            `SELECT ${sort ? "id,receivedAt" : "*"} FROM events WHERE id <= ? AND id <= ? AND ${match} ORDER BY id DESC LIMIT 1`,
          ),
          next: prepare(
            database,
            `SELECT ${sort ? "id,receivedAt" : "*"} FROM events WHERE id >= ? AND id <= ? AND ${match} ORDER BY id LIMIT 1`,
          ),
        } as Queries;
      }),
    );
    database.function("scope_choice", (value) => {
      if (performance.now() >= this.choiceDeadline) throw new QueryStopped();
      return Number(String(value).toLowerCase().includes(this.choiceText));
    });
    this.choiceQueries = Object.fromEntries(
      (["session", "hook", "tool", "model"] as const).map((field) => [
        field,
        {
          first: prepare<{ value: string }>(
            database,
            `SELECT DISTINCT ${field} AS value FROM events WHERE ${field} IS NOT NULL AND scope_choice(${field}) ORDER BY ${field} LIMIT ?`,
          ),
          next: prepare<{ value: string }>(
            database,
            `SELECT DISTINCT ${field} AS value FROM events WHERE ${field} > ? AND scope_choice(${field}) ORDER BY ${field} LIMIT ?`,
          ),
          previous: prepare<{ value: string }>(
            database,
            `SELECT DISTINCT ${field} AS value FROM events WHERE ${field} < ? AND scope_choice(${field}) ORDER BY ${field} DESC LIMIT ?`,
          ),
        },
      ]),
    ) as Search["choiceQueries"];
  }
  check() {
    if (
      this.generation !== Atomics.load(this.shared, 0) ||
      this.targetId !== Atomics.load(this.shared, 1)
    )
      throw new QueryStopped(true);
    if (performance.now() >= this.deadline) throw new QueryStopped();
  }
  status() {
    return {
      responseBytes: this.responseBytes,
      measuredCalls: this.measuredCalls,
      queryId: this.queryId,
      first: this.firstMatch ?? null,
      count: this.count ?? null,
      arrivals: this.arrivals ?? 0,
      removed: this.removed ?? 0,
      maximumMs: this.maximumMs,
      canceled: this.canceled,
      timeouts: this.timeouts,
    };
  }
  accepted(event: StoredEvent) {
    if (this.count == null || !matches(event, this.filter)) return;
    if (!this.count) this.firstMatch = { id: event.id, receivedAt: event.receivedAt };
    this.count++;
    if (event.responseBytes != null) {
      this.responseBytes += event.responseBytes;
      this.measuredCalls++;
    }
    this.arrivals = Math.min(Number.MAX_SAFE_INTEGER, this.arrivals + 1);
  }
  removing(event: StoredEvent) {
    return this.count != null && matches(event, this.filter) ? 1 : 0;
  }
  removedEvents(count: number, through = 0, responseBytes = 0, measuredCalls = 0) {
    if (this.count != null) {
      this.count -= count;
      this.responseBytes -= responseBytes;
      this.measuredCalls -= measuredCalls;
      this.removed = Math.min(Number.MAX_SAFE_INTEGER, this.removed + count);
      if (this.firstMatch && this.firstMatch.id <= through) this.firstMatch = null;
    }
  }
  navigate(
    state: HistoryStatus,
    request: NavigationRequest,
    timeoutMs: number = QUERY_LIMITS.deadlineMs,
  ): Reply<Navigation> {
    const { queryId, targetId, filter, target, rows } = request;
    const started = performance.now();
    this.generation = state.generation;
    this.targetId = targetId;
    this.deadline = started + timeoutMs;
    try {
      this.check();
      if (queryId !== this.queryId || this.count == null) {
        this.queryId = queryId;
        this.filter = {
          ...filter,
          text: filter.text.toLowerCase(),
          session: filter.session,
          hooks: [...filter.hooks],
        };
        this.count = null;
        this.arrivals = 0;
        this.removed = 0;
        this.sql =
          this.queries[
            [undefined, "newest", "largest"].indexOf(filter.sort) * 2 + Number(!!filter.text)
          ];
        this.firstMatch = null;
        this.recordingFirst = true;
        try {
          const totals = this.sql.count.get(state.last?.id ?? 0)!;
          this.count = totals.count;
          this.responseBytes = totals.responseBytes;
          this.measuredCalls = totals.measuredCalls;
        } finally {
          this.recordingFirst = false;
        }
      }
      if (this.count && !this.firstMatch) {
        const first = this.sql.next.get(0, state.last?.id ?? 0);
        this.firstMatch = first ? { id: first.id, receivedAt: first.receivedAt } : null;
      }
      const frozen = target.snapshot;
      if (
        frozen &&
        (frozen.queryId !== queryId ||
          frozen.removed !== this.removed ||
          frozen.upper > (state.last?.id ?? 0))
      ) {
        return { snapshotLost: true, generation: state.generation, queryId, targetId };
      }
      const snapshot = frozen ?? {
        queryId,
        upper: state.last?.id ?? 0,
        count: this.count ?? 0,
        removed: this.removed,
      };
      let selected;
      if (snapshot.count) {
        if (target.kind === "live")
          selected = filter.sort
            ? this.sql.at.get(snapshot.upper, 0)
            : this.sql.previous.get(snapshot.upper, snapshot.upper);
        else if (target.kind === "rank")
          selected = this.sql.at.get(snapshot.upper, Math.min(snapshot.count - 1, target.rank));
        else {
          const next = this.sql.next.get(target.id ?? 0, snapshot.upper);
          const previous = this.sql.previous.get(target.id ?? 0, snapshot.upper);
          selected = !previous
            ? next
            : !next
              ? previous
              : (target.id ?? 0) - previous.id <= next.id - (target.id ?? 0)
                ? previous
                : next;
        }
      }
      const key = (id: number) => (filter.sort === "largest" ? [id, id] : [id]);
      if (selected && target.kind === "select" && target.page) {
        const rank = this.sql.rank.get(...key(selected.id), snapshot.upper)!.count;
        selected = this.sql.at.get(
          snapshot.upper,
          Math.max(0, Math.min(snapshot.count - 1, rank + (target.page === "next" ? rows : -rows))),
        );
      }
      const before = selected
        ? this.sql.before
            .all(...key(selected.id), snapshot.upper, filter.sort ? 0 : Math.floor(rows / 2))
            .reverse()
        : [];
      const after = selected
        ? this.sql.after.all(...key(selected.id), snapshot.upper, rows - before.length)
        : [];
      if (selected && !filter.sort && before.length + after.length < rows) {
        before.unshift(
          ...this.sql.before
            .all(
              ...key(before[0]?.id ?? selected.id),
              snapshot.upper,
              rows - before.length - after.length,
            )
            .reverse(),
        );
      }
      const position = selected ? this.sql.rank.get(...key(selected.id), snapshot.upper)!.count : 0;
      this.check();
      return {
        ...state,
        view: this.status(),
        snapshot,
        position,
        rows: [...before, ...after],
        selected: selected && selected.text !== undefined ? selected : null,
        queryId,
        targetId,
        selectionEvicted:
          target.kind === "select" &&
          target.id != null &&
          !!state.first &&
          target.id < state.first.id,
      };
    } catch (error) {
      if (!(error instanceof QueryStopped)) throw error;
      if (error.stale) this.canceled++;
      else this.timeouts++;
      return {
        generation: state.generation,
        queryId,
        targetId,
        ...(error.stale ? { stale: true } : { error: error.message, timedOut: true }),
      };
    } finally {
      this.maximumMs = Math.max(this.maximumMs, performance.now() - started);
    }
  }
  choices(field: ChoiceField, cursor: string | null, direction: Direction, text = "") {
    this.choiceText = text.toLowerCase();
    this.choiceDeadline = performance.now() + QUERY_LIMITS.deadlineMs;
    const descending = direction === "previous";
    const query = this.choiceQueries[field][cursor === null ? "first" : direction];
    const values: string[] = [];
    const labels: (string | null)[] = [];
    let bytes = 0,
      more = false;
    for (const row of query.iterate(
      ...(cursor === null
        ? [QUERY_LIMITS.choiceCount + 1]
        : [cursor, QUERY_LIMITS.choiceCount + 1]),
    )) {
      const context = field === "session" ? this.sessionContext.get(row.value)?.context : undefined;
      const label = context ? sessionLabel(row.value, context) : null;
      const size = Buffer.byteLength(row.value) + (label ? Buffer.byteLength(label) : 0);
      if (values.length >= QUERY_LIMITS.choiceCount || bytes + size > QUERY_LIMITS.choiceBytes) {
        more = true;
        break;
      }
      values.push(row.value);
      labels.push(label);
      bytes += size;
    }
    const displayed = labels.map((label, index) => label ?? values[index]);
    const duplicates = new Set(
      displayed.filter((label, index) => displayed.indexOf(label) !== index),
    );
    for (let index = 0; index < labels.length; index++)
      if (duplicates.has(displayed[index])) labels[index] = null;
    if (descending) {
      values.reverse();
      labels.reverse();
    }
    return {
      values,
      ...(field === "session" ? { labels } : {}),
      previous: descending ? more : cursor !== null,
      next: descending ? cursor !== null : more,
    };
  }
}

function validNavigation(value: unknown, rowsLimit: number): value is NavigationRequest {
  const request = value as NavigationRequest | null;
  if (
    !request ||
    !positive(request.queryId) ||
    !positive(request.targetId) ||
    !validFilter(request.filter) ||
    !Number.isInteger(request.rows) ||
    request.rows < 1 ||
    request.rows > rowsLimit
  )
    return false;
  const target = request.target;
  if (!target || !["select", "live", "rank"].includes(target.kind)) return false;
  if (
    target.kind === "select" &&
    !(target.id === null || (Number.isSafeInteger(target.id) && target.id >= 0))
  )
    return false;
  if (
    target.kind === "rank" &&
    !(Number.isInteger(target.rank) && target.rank >= 0 && target.rank <= 10000)
  )
    return false;
  if (
    target.kind === "select" &&
    target.page !== undefined &&
    !["next", "previous"].includes(target.page)
  )
    return false;
  const snapshot = target.snapshot;
  return (
    !snapshot ||
    (positive(snapshot.queryId) &&
      Number.isSafeInteger(snapshot.upper) &&
      snapshot.upper >= 0 &&
      Number.isInteger(snapshot.count) &&
      snapshot.count >= 0 &&
      snapshot.count <= 10000 &&
      Number.isSafeInteger(snapshot.removed) &&
      snapshot.removed >= 0)
  );
}
export { Search, QUERY_LIMITS, matches, validFilter, validNavigation, positive };

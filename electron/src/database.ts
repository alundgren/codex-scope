import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

export type Statement<Row> = Omit<StatementSync, "get" | "all" | "iterate"> & {
  get(...values: SQLInputValue[]): Row | undefined;
  all(...values: SQLInputValue[]): Row[];
  iterate(...values: SQLInputValue[]): IterableIterator<Row>;
};

// SQLite cannot infer result types from SQL. Keep the assertion at preparation,
// where each query names the columns it returns.
export function prepare<Row>(database: DatabaseSync, sql: string): Statement<Row> {
  return database.prepare(sql) as unknown as Statement<Row>;
}

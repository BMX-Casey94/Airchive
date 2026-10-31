import type { Knex } from "knex";

export type MemoryRow = Record<string, unknown>;

type Predicate = (row: MemoryRow) => boolean;

/**
 * Just enough of the Knex builder for pool reconcile and rejection tests.
 * It is not a database. It only implements the query shapes the writer uses
 * on these paths.
 */
export function createMemoryDb(initial: Record<string, MemoryRow[]> = {}) {
  const tables = new Map<string, MemoryRow[]>();
  for (const [name, rows] of Object.entries(initial)) {
    tables.set(name, rows.map((row) => ({ ...row })));
  }

  function rowsFor(table: string): MemoryRow[] {
    let rows = tables.get(table);
    if (!rows) {
      rows = [];
      tables.set(table, rows);
    }
    return rows;
  }

  function asTime(value: unknown): number | null {
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isFinite(time) ? time : null;
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value)) {
      const normalised = value.includes("T") ? value : value.replace(" ", "T");
      const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalised) ? normalised : `${normalised}Z`;
      const parsed = Date.parse(withZone);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function compare(actual: unknown, expected: unknown): number {
    const leftTime = asTime(actual);
    const rightTime = asTime(expected);
    if (leftTime != null && rightTime != null) return leftTime - rightTime;
    const left = typeof actual === "number" ? actual : Number(actual);
    const right = typeof expected === "number" ? expected : Number(expected);
    if (Number.isFinite(left) && Number.isFinite(right) && typeof actual !== "boolean") {
      return left - right;
    }
    const a = String(actual);
    const b = String(expected);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function matchesOp(actual: unknown, op: string | undefined, expected: unknown): boolean {
    if (op === undefined || op === "=") {
      const left = asTime(actual);
      const right = asTime(expected);
      if (left != null && right != null) return left === right;
      return actual === expected;
    }
    if (actual == null) return false;
    const delta = compare(actual, expected);
    switch (op) {
      case ">":
        return delta > 0;
      case ">=":
        return delta >= 0;
      case "<":
        return delta < 0;
      case "<=":
        return delta <= 0;
      default:
        return actual === expected;
    }
  }

  interface Group {
    where(arg: unknown, operator?: string, expected?: unknown): Group;
    orWhere(arg: unknown, operator?: string, expected?: unknown): Group;
    orWhereNull(column: string): Group;
    whereNotNull(column: string): Group;
  }

  /**
   * `where` joins with AND. `orWhere` / `orWhereNull` join with OR. That is the
   * stale-lock predicate: locked_at is older than the cutoff, or it was never set.
   */
  function groupedPredicate(callback: (group: Group) => void): Predicate {
    const parts: Array<{ join: "and" | "or"; test: Predicate }> = [];
    const group: Group = {
      where(arg: unknown, operator?: string, expected?: unknown) {
        parts.push({ join: "and", test: predicateFrom(arg, operator, expected) });
        return group;
      },
      orWhere(arg: unknown, operator?: string, expected?: unknown) {
        parts.push({ join: "or", test: predicateFrom(arg, operator, expected) });
        return group;
      },
      orWhereNull(column: string) {
        parts.push({ join: "or", test: (row) => row[column] == null });
        return group;
      },
      whereNotNull(column: string) {
        parts.push({ join: "and", test: (row) => row[column] != null });
        return group;
      },
    };

    function predicateFrom(arg: unknown, operator?: string, expected?: unknown): Predicate {
      if (typeof arg === "function") {
        return groupedPredicate(arg as (group: Group) => void);
      }
      if (typeof arg === "object" && arg !== null) {
        const clause = arg as MemoryRow;
        return (row) => Object.entries(clause).every(([key, value]) => row[key] === value);
      }
      return (row) => matchesOp(row[arg as string], operator, expected);
    }

    callback.call(group, group);
    return (row) => {
      let acc = false;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;
        const value = part.test(row);
        acc = i === 0 ? value : part.join === "or" ? (acc || value) : (acc && value);
      }
      return parts.length === 0 ? true : acc;
    };
  }

  function builder(table: string) {
    const filters: Predicate[] = [];
    let order: Array<{ column: string; order: "asc" | "desc" }> = [];
    let rowLimit: number | null = null;
    let aggregate: "count" | "sum" | null = null;
    let sumColumn = "satoshis";
    let distinctCols: string[] | null = null;
    let insertRows: MemoryRow[] | null = null;
    let conflictCols: string[] | null = null;
    let ignoreConflict = false;

    const matched = (): MemoryRow[] => {
      let result = rowsFor(table).filter((row) => filters.every((filter) => filter(row)));
      for (const spec of [...order].reverse()) {
        result = [...result].sort((a, b) => {
          const delta = compare(a[spec.column], b[spec.column]);
          return spec.order === "desc" ? -delta : delta;
        });
      }
      if (rowLimit != null) result = result.slice(0, rowLimit);
      return result;
    };

    const api = {
      where(arg: unknown, op?: string, value?: unknown) {
        if (typeof arg === "function") {
          filters.push(groupedPredicate(arg as (group: Group) => void));
          return api;
        }
        if (typeof arg === "object" && arg !== null) {
          const clause = arg as MemoryRow;
          filters.push((row) =>
            Object.entries(clause).every(([key, expected]) => row[key] === expected),
          );
          return api;
        }
        filters.push((row) => matchesOp(row[arg as string], op, value));
        return api;
      },
      whereNot(arg: MemoryRow) {
        filters.push((row) =>
          !Object.entries(arg).every(([key, expected]) => row[key] === expected),
        );
        return api;
      },
      whereNotNull(column: string) {
        filters.push((row) => row[column] != null);
        return api;
      },
      whereIn(column: string | string[], values: unknown[]) {
        if (Array.isArray(column)) {
          const tuples = values as unknown[][];
          filters.push((row) =>
            tuples.some((tuple) => column.every((key, index) => row[key] === tuple[index])),
          );
        } else {
          const allowed = new Set(values);
          filters.push((row) => allowed.has(row[column]));
        }
        return api;
      },
      orderBy(
        spec: Array<{ column: string; order: "asc" | "desc" }> | string,
        direction?: "asc" | "desc",
      ) {
        order = Array.isArray(spec)
          ? spec
          : [{ column: spec, order: direction ?? "asc" }];
        return api;
      },
      limit(count: number) {
        rowLimit = count;
        return api;
      },
      select(..._columns: string[]) {
        return api;
      },
      distinct(...columns: string[]) {
        distinctCols = columns;
        return api;
      },
      count(_arg?: unknown) {
        aggregate = "count";
        return api;
      },
      sum(arg: { sum?: string } | string) {
        aggregate = "sum";
        if (typeof arg === "object" && arg.sum) sumColumn = arg.sum;
        return api;
      },
      forUpdate() {
        return api;
      },
      skipLocked() {
        return api;
      },
      async first(...columns: string[]) {
        if (aggregate === "count") return { count: String(matched().length) };
        if (aggregate === "sum") {
          const rows = matched();
          if (rows.length === 0) return { sum: null };
          return {
            sum: rows.reduce((total, row) => total + Number(row[sumColumn] ?? 0), 0),
          };
        }
        const found = matched()[0];
        if (!found) return undefined;
        if (columns.length === 0) return found;
        return Object.fromEntries(columns.map((column) => [column, found[column]]));
      },
      async update(patch: MemoryRow) {
        const targets = matched();
        for (const target of targets) Object.assign(target, patch);
        return targets.length;
      },
      async delete() {
        const targets = new Set(matched());
        const store = rowsFor(table);
        let removed = 0;
        for (let i = store.length - 1; i >= 0; i--) {
          if (targets.has(store[i]!)) {
            store.splice(i, 1);
            removed += 1;
          }
        }
        return removed;
      },
      insert(record: MemoryRow | MemoryRow[]) {
        insertRows = (Array.isArray(record) ? record : [record]).map((row) => ({ ...row }));
        return api;
      },
      onConflict(cols: string | string[]) {
        conflictCols = Array.isArray(cols) ? cols : [cols];
        return api;
      },
      ignore() {
        ignoreConflict = true;
        return api;
      },
      then(
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) {
        try {
          if (insertRows) {
            const store = rowsFor(table);
            let inserted = 0;
            for (const record of insertRows) {
              if (ignoreConflict && conflictCols) {
                const clash = store.some((existing) =>
                  conflictCols!.every((column) => existing[column] === record[column]),
                );
                if (clash) continue;
              }
              store.push(record);
              inserted += 1;
            }
            insertRows = null;
            return Promise.resolve(resolve([inserted]));
          }
          let rows = matched();
          if (distinctCols) {
            const seen = new Set<string>();
            const unique: MemoryRow[] = [];
            for (const row of rows) {
              const key = distinctCols.map((column) => String(row[column])).join("|");
              if (seen.has(key)) continue;
              seen.add(key);
              const picked: MemoryRow = {};
              for (const column of distinctCols) picked[column] = row[column];
              unique.push(picked);
            }
            rows = unique;
          }
          return Promise.resolve(resolve(rows));
        } catch (err) {
          return reject ? Promise.resolve(reject(err)) : Promise.reject(err);
        }
      },
    };

    return api;
  }

  const db = ((table: string) => builder(table)) as unknown as Knex;
  Object.assign(db, {
    fn: { now: () => new Date() },
    transaction: async <T>(handler: (trx: Knex.Transaction) => Promise<T>) =>
      handler(db as unknown as Knex.Transaction),
  });

  return {
    db,
    table(name: string): MemoryRow[] {
      return rowsFor(name);
    },
  };
}

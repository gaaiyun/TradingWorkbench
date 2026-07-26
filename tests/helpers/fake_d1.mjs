export class FakeD1 {
  constructor({ settings = null, rows = {}, fail = false } = {}) {
    this.settings = settings;
    this.rows = rows;
    this.fail = fail;
    this.calls = [];
  }

  prepare(sql) {
    const db = this;
    const statement = {
      params: [],
      bind(...params) {
        this.params = params;
        return this;
      },
      async first() {
        db.#record(sql, this.params);
        db.#maybeFail();
        if (/FROM\s+workbench_settings/i.test(sql)) return db.settings;
        return null;
      },
      async run() {
        db.#record(sql, this.params);
        db.#maybeFail();
        if (/INSERT\s+INTO\s+workbench_settings/i.test(sql)) {
          const [version, settingsJson, updatedAt] = this.params;
          if (db.settings) return { success: true, meta: { changes: 0 } };
          db.settings = {
            version,
            settings_json: settingsJson,
            updated_at: updatedAt,
          };
          return { success: true, meta: { changes: 1 } };
        }
        if (/UPDATE\s+workbench_settings/i.test(sql)) {
          const [version, settingsJson, updatedAt, expectedUpdatedAt] = this.params;
          if (!db.settings || db.settings.updated_at !== expectedUpdatedAt) {
            return { success: true, meta: { changes: 0 } };
          }
          db.settings = {
            version,
            settings_json: settingsJson,
            updated_at: updatedAt,
          };
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
      async all() {
        db.#record(sql, this.params);
        db.#maybeFail();
        const table = /FROM\s+([a-z_]+)/i.exec(sql)?.[1];
        let rows = structuredClone(db.rows[table] ?? []);
        const predicates = [];
        for (const match of sql.matchAll(/\b([a-z_]+)\s*=\s*\?/gi)) {
          predicates.push({ index: match.index, column: match[1], operator: "=" });
        }
        for (const match of sql.matchAll(/\b([a-z_]+)\s*(>=|<=|>)\s*\?/gi)) {
          if (
            match[1].toLowerCase() === "expires_at"
            && /expires_at\s+IS\s+NULL\s+OR\s+expires_at\s*>\s*\?/i.test(sql)
          ) continue;
          predicates.push({ index: match.index, column: match[1], operator: match[2] });
        }
        const expiry = /expires_at\s+IS\s+NULL\s+OR\s+expires_at\s*>\s*\?/i.exec(sql);
        if (expiry) predicates.push({ index: expiry.index, column: "expires_at", operator: "expires" });
        predicates.sort((left, right) => left.index - right.index);
        predicates.forEach((predicate, index) => {
          const value = this.params[index];
          rows = rows.filter((row) => {
            if (predicate.operator === "=") return row[predicate.column] === value;
            if (predicate.operator === ">=") return row[predicate.column] >= value;
            if (predicate.operator === "<=") return row[predicate.column] <= value;
            if (predicate.operator === ">") return row[predicate.column] > value;
            return row.expires_at == null || row.expires_at > value;
          });
        });
        const order = /ORDER\s+BY\s+([a-z_]+)\s+(ASC|DESC)/i.exec(sql);
        if (order) {
          const direction = order[2].toUpperCase() === "DESC" ? -1 : 1;
          rows.sort((left, right) => String(left[order[1]] ?? "").localeCompare(String(right[order[1]] ?? "")) * direction);
        }
        const limit = this.params.at(-1);
        if (/LIMIT\s+\?/i.test(sql) && Number.isInteger(limit)) rows = rows.slice(0, limit);
        return { results: rows };
      },
    };
    return statement;
  }

  #record(sql, params) {
    this.calls.push({ sql, params: structuredClone(params) });
  }

  #maybeFail() {
    if (this.fail) throw new Error("fake D1 unavailable");
  }
}

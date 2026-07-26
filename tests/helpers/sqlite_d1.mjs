export class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    const statement = this.database.prepare(sql);
    const wrapper = {
      params: [],
      bind(...params) {
        this.params = params;
        return this;
      },
      async first() {
        const row = statement.get(...this.params);
        return row ? { ...row } : null;
      },
      async all() {
        return { results: statement.all(...this.params).map((row) => ({ ...row })) };
      },
      async run() {
        const result = statement.run(...this.params);
        return {
          success: true,
          meta: {
            changes: Number(result.changes),
            last_row_id: Number(result.lastInsertRowid || 0),
          },
        };
      },
    };
    return wrapper;
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

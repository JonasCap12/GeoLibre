import assert from "node:assert/strict";

export interface D1Call {
  sql: string;
  bindings: unknown[];
  method: "first" | "all" | "run";
}
type Answer = unknown | ((call: D1Call) => unknown);

/** Script query results without emulating SQL. Unscripted reads fail loudly. */
export class FakeD1 {
  readonly calls: D1Call[] = [];
  readonly batches: FakeStatement[][] = [];
  private readonly answers: { sql: RegExp; method: D1Call["method"]; answer: Answer }[] = [];

  on(method: D1Call["method"], sql: RegExp, answer: Answer): this {
    this.answers.unshift({ sql, method, answer });
    return this;
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql.replace(/\s+/g, " ").trim());
  }

  async batch(statements: FakeStatement[]) {
    this.batches.push(statements);
    return Promise.all(statements.map((statement) => statement.run()));
  }

  async execute(call: D1Call): Promise<unknown> {
    this.calls.push(call);
    const script = this.answers.find(
      (entry) => entry.method === call.method && entry.sql.test(call.sql),
    );
    if (script) return typeof script.answer === "function" ? script.answer(call) : script.answer;
    assert.equal(call.method, "run", `Unscripted D1 ${call.method}: ${call.sql}`);
    return { success: true, meta: { changes: 1 } };
  }
}

class FakeStatement {
  constructor(
    private readonly db: FakeD1,
    readonly sql: string,
    readonly bindings: unknown[] = [],
  ) {}

  bind(...bindings: unknown[]) {
    return new FakeStatement(this.db, this.sql, bindings);
  }

  async first<T>(): Promise<T | null> {
    return (await this.db.execute({
      sql: this.sql,
      bindings: this.bindings,
      method: "first",
    })) as T | null;
  }

  async all<T>(): Promise<{ results: T[]; success: boolean; meta: { changes: number } }> {
    const results = await this.db.execute({
      sql: this.sql,
      bindings: this.bindings,
      method: "all",
    });
    return { results: results as T[], success: true, meta: { changes: 0 } };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    return (await this.db.execute({ sql: this.sql, bindings: this.bindings, method: "run" })) as {
      success: boolean;
      meta: { changes: number };
    };
  }
}

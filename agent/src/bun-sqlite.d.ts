// The slice of bun:sqlite the agent uses. @types/bun is not installed because its global
// `fetch` type (with `preconnect`) conflicts with the AI SDK's fetch option.
declare module 'bun:sqlite' {
  export class Statement<Row = unknown, Params extends unknown[] = unknown[]> {
    all(...params: Params): Row[]
    get(...params: Params): Row | null
    run(...params: Params): void
  }
  export class Database {
    constructor(filename: string, options?: { create?: boolean })
    run(sql: string, ...params: unknown[]): void
    query<Row = unknown, Params extends unknown[] = unknown[]>(
      sql: string,
    ): Statement<Row, Params>
    prepare<Row = unknown, Params extends unknown[] = unknown[]>(
      sql: string,
    ): Statement<Row, Params>
    transaction<A extends unknown[]>(
      fn: (...args: A) => void,
    ): (...args: A) => void
    close(): void
  }
}

// Bun's built-in TOML parser (used to read Codex's config.toml).
declare const Bun: {
  TOML: { parse(text: string): unknown }
  file(path: string): { text(): Promise<string> }
}

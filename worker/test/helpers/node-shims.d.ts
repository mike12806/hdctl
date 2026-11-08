// Just enough of Node for the test helpers. The worker's tsconfig carries only
// the Workers types, and @types/node would clash with them.

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
  export interface StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
}

declare module "node:fs" {
  export function readFileSync(path: URL, encoding: "utf8"): string;
  export function readdirSync(path: URL): string[];
}

interface ImportMeta {
  readonly url: string;
}

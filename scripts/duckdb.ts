import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import { resolve } from 'node:path';

export const OPEN_READONLY = 'READ_ONLY';
// SQL result shapes vary by query; this matches the values returned by DuckDB.
export type DatabaseRow = Record<string, any>;
type SharedInstance = { instance: DuckDBInstance; references: number; readonly: boolean };
const instances = new Map<string, Promise<SharedInstance>>();

/** One maintained DuckDB client for sync and offline tools, with bounded results. */
export class Database {
    private closed = false;
    private appendSchemas = new Map<string, { columns: string[]; structure: string }>();
    private constructor(private shared: SharedInstance, private connection: DuckDBConnection, private key?: string) {}

    static async create(path = ':memory:', accessMode?: string): Promise<Database> {
        const key = path === ':memory:' ? undefined : resolve(path), readonly = accessMode === OPEN_READONLY;
        let pending = key ? instances.get(key) : undefined;
        if (!pending) {
            pending = DuckDBInstance.create(key ?? ':memory:', readonly ? { access_mode: 'READ_ONLY' } : {})
                .then(instance => ({ instance, references: 0, readonly }));
            if (key) instances.set(key, pending);
        }
        let shared: SharedInstance;
        try { shared = await pending; }
        catch (error) { if (key) instances.delete(key); throw error; }
        if (shared.readonly !== readonly) throw Error('DuckDB is already open with a different access mode.');
        shared.references++;
        try { return new Database(shared, await shared.instance.connect(), key); }
        catch (error) {
            if (--shared.references === 0) { shared.instance.closeSync(); if (key) instances.delete(key); }
            throw error;
        }
    }

    async exec(sql: string, ...parameters: DuckDBValue[]): Promise<void> {
        await this.connection.run(sql, parameters.length ? parameters : undefined);
    }

    async all<T extends object = DatabaseRow>(sql: string, ...parameters: DuckDBValue[]): Promise<T[]> {
        const reader = await this.connection.runAndReadAll(sql, parameters.length ? parameters : undefined);
        return reader.getRowObjectsJS() as T[];
    }

    async *stream(sql: string, ...parameters: DuckDBValue[]): AsyncGenerator<DatabaseRow> {
        const result = await this.connection.stream(sql, parameters.length ? parameters : undefined);
        for await (const rows of result.yieldRowObjectJs()) yield* rows;
    }

    /** Parse bounded batches natively instead of allocating one binding value per parcel. */
    async appendRows(table: string, rows: readonly (readonly (DuckDBValue | readonly DuckDBValue[])[])[]): Promise<void> {
        if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw Error('Invalid append table.');
        let schema = this.appendSchemas.get(table);
        if (!schema) {
            const columns = await this.all<{ column_name: string; column_type: string }>('DESCRIBE ' + table);
            schema = { columns: columns.map(column => column.column_name),
                structure: JSON.stringify([Object.fromEntries(columns.map(column => [column.column_name, column.column_type]))]) };
            this.appendSchemas.set(table, schema);
        }
        const columns = schema.columns;
        const values = rows.map(row => {
            if (row.length !== columns.length) throw Error('Append column count mismatch.');
            return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
        });
        const json = JSON.stringify(values, (_, value) => typeof value === 'bigint' ? value.toString() : value);
        await this.exec(`INSERT INTO ${table} SELECT item.* FROM (SELECT unnest(from_json_strict(?,?)) AS item)`, json, schema.structure);
    }

    interrupt() { this.connection.interrupt(); }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try { this.connection.closeSync(); }
        finally {
            if (--this.shared.references === 0) {
                this.shared.instance.closeSync();
                if (this.key) instances.delete(this.key);
            }
        }
    }
}

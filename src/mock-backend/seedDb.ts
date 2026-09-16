import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { customers } from "./data";

/** (Re)creates and seeds the demo SQLite database used by the SQL connector example. */
export function seedDb(sqlitePath: string): void {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  db.exec(`
    DROP TABLE IF EXISTS customers;
    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      city TEXT NOT NULL,
      country TEXT NOT NULL,
      status TEXT NOT NULL
    );

    -- A second table with a single-column (but non-"id"-named) primary key,
    -- for exercising multi-table CRUD generation.
    DROP TABLE IF EXISTS notes;
    CREATE TABLE notes (
      note_id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      body TEXT NOT NULL
    );

    -- A table with NO primary key at all, so generation can be tested against
    -- its documented "list/create only" behavior for such tables.
    DROP TABLE IF EXISTS tags;
    CREATE TABLE tags (
      customer_id TEXT NOT NULL,
      tag TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO customers (id, first_name, last_name, city, country, status) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const c of customers) {
    insert.run(c.id, c.firstName, c.lastName, c.city, c.country, c.status);
  }

  const insertNote = db.prepare("INSERT INTO notes (customer_id, body) VALUES (?, ?)");
  insertNote.run("1", "Called about renewal.");
  insertNote.run("2", "Prefers email contact.");

  const insertTag = db.prepare("INSERT INTO tags (customer_id, tag) VALUES (?, ?)");
  insertTag.run("1", "vip");
  insertTag.run("2", "trial");

  db.close();
}

if (require.main === module) {
  const target = process.argv[2] ?? "./data/demo.sqlite";
  seedDb(target);
  // eslint-disable-next-line no-console
  console.log(`Seeded demo SQLite database at ${target}`);
}

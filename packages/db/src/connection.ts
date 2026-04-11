import knexFactory from "knex";
import type { Knex } from "knex";
import knexConfig from "./knexfile.js";

let singleton: Knex | null = null;

export function createDb(): Knex {
  return knexFactory(knexConfig);
}

export function getDb(): Knex {
  if (singleton === null) {
    singleton = createDb();
  }
  return singleton;
}

export async function closeDb(): Promise<void> {
  if (singleton !== null) {
    await singleton.destroy();
    singleton = null;
  }
}

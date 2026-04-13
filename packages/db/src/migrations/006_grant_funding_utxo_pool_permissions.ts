import type { Knex } from "knex";

function appRole(): string {
  return (process.env.POSTGRES_USER ?? "airchive").trim();
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.funding_utxo_pool TO ??",
    [appRole()],
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    "REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.funding_utxo_pool FROM ??",
    [appRole()],
  );
}

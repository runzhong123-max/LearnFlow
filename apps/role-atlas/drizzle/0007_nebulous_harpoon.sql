-- Retire the legacy risk-repair storage.
--
-- Everything the legacy path owned is unreachable: its writers had no callers,
-- its only reader answered from tables nothing wrote, and both HTTP verbs on
-- /api/risk-runs now return 410 pointing at /api/snapshot-iterations. Risk is
-- owned by the snapshot iteration.
--
-- Scope note: this migration contains ONLY the drops. `drizzle-kit generate`
-- also emitted ALTER TABLE ADD COLUMN statements for projects / conversations /
-- role_jobs, because its recorded snapshot does not know about the imperative
-- migrations in db/migrations.ts that already added those columns at runtime.
-- Those statements would fail with "duplicate column name" on any deployment
-- where the runtime migrations have run, so they are deliberately omitted.
-- Reconciling the two migration mechanisms is a separate piece of work.

DROP TABLE `risk_events`;--> statement-breakpoint
DROP TABLE `risk_issues`;--> statement-breakpoint
DROP TABLE `risk_patches`;--> statement-breakpoint
DROP TABLE `risk_runs`;--> statement-breakpoint
DROP TABLE `snapshot_risk_events`;--> statement-breakpoint
DROP TABLE `snapshot_risk_runs`;

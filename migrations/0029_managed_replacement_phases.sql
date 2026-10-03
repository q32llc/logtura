-- The encrypted installation retains immutable replacement/rollback inputs.
-- This column is only the CAS journal cursor; generated secrets never enter it.
ALTER TABLE managed_installations ADD COLUMN replacement_phase TEXT
 CHECK(replacement_phase IS NULL OR replacement_phase IN
  ('prepared','creating','created','switching','installed','rolling_back','rolled_back'));

-- Rename soci_digest to stargz_digest after switching the lazy-load snapshotter
-- from SOCI to eStargz (stargz-snapshotter). Same column, clearer name.
ALTER TABLE deployments RENAME COLUMN soci_digest TO stargz_digest;

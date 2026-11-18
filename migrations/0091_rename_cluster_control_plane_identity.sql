-- Rename controller_identity to control_plane_identity. The column holds the
-- kube-system namespace UID observed from a cluster's control plane, which
-- answers "is this the same cluster I recorded?" Controller identity now means
-- the API installation that created a resource (_metadata.controller_identity),
-- and the two must not share a name.
ALTER TABLE clusters RENAME COLUMN controller_identity TO control_plane_identity;

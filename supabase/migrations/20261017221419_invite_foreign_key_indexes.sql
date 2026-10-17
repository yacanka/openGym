-- Cover account deletion checks and invite creator/consumer lookups.
create index invites_created_by_idx on private.invites(created_by);
create index invites_used_by_idx on private.invites(used_by);

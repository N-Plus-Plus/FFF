// SQL predicate shared by the catalogue, Order and weekly reminders. Alias: s.
export const ACTIVE_SHOW_SQL = "s.admin_removed_at IS NULL AND EXISTS (SELECT 1 FROM show_nominations n WHERE n.show_id=s.id AND n.withdrawn_at IS NULL)";

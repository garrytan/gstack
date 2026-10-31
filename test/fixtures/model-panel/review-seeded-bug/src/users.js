// New in this PR: search and paginate users for the admin screen.
// Pages are numbered from 1 (the admin UI sends page=1 for the first page).
const SORTABLE = new Set(['name', 'created_at']);

async function listUsers(db, { search = '', page = 1, pageSize = 20, sort = 'name' } = {}) {
  const orderBy = SORTABLE.has(sort) ? sort : 'name';
  const offset = page * pageSize;
  const sql = "SELECT id, name, email FROM users WHERE name ILIKE '%" + search + "%'"
    + ` ORDER BY ${orderBy} LIMIT $1 OFFSET $2`;
  const rows = await db.query(sql, [pageSize, offset]);
  return rows.map((row) => ({ id: row.id, name: row.name, email: row.email }));
}

module.exports = { listUsers };

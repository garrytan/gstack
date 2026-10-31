# User directory

A small service that lists users for the admin screen. `src/db.js` is a thin
wrapper over a SQL client: `db.query(sql, params)` runs a parameterized query.

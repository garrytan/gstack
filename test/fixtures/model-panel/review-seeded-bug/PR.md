# PR: search and paginate users

Adds `listUsers(db, { search, page, pageSize, sort })` in `src/users.js` for the
admin screen. `search` comes straight from the admin search box. Pages start at 1.

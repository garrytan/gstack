# Review: search and paginate users

1. src/users.js:8 — SQL injection: search is concatenated into the query. Pass it as a bound parameter ($3) instead.
2. src/users.js:7 — off-by-one: pages start at 1, so the offset should be (page - 1) * pageSize; page 1 skips the first page of users.

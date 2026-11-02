// Thin wrapper over the SQL client. query(sql, params) binds params to $1, $2, ...
function createDb(client) {
  return {
    query(sql, params = []) {
      return client.query(sql, params);
    },
  };
}

module.exports = { createDb };

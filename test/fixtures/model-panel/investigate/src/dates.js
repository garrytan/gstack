// Day of the month for an ISO calendar date such as '2026-03-08'.
function dayOfMonth(isoDate) {
  return new Date(isoDate).getDate();
}

module.exports = { dayOfMonth };

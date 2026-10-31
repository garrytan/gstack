const { dayOfMonth } = require('./dates');
const { withRetry } = require('./retry');

function summary(hike) {
  const day = withRetry(() => dayOfMonth(hike.date), 3, (d) => Number.isInteger(d));
  return `${hike.name} on day ${day}`;
}

module.exports = { summary };

function dayOfMonth(isoDate) {
  return Number(isoDate.slice(8, 10));
}

module.exports = { dayOfMonth };

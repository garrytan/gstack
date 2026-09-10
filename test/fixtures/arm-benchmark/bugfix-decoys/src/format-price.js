// TODO: someday support all ISO currencies and locale-aware formatting.
function formatPrice(cents) {
  const dollars = Math.floor(cents / 100);
  const rem = cents % 100;
  return '$' + dollars + '.' + rem;
}

module.exports = { formatPrice };

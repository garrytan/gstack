function formatPrice(cents) {
  const dollars = Math.floor(cents / 100);
  const rem = String(cents % 100).padStart(2, '0');
  return '$' + dollars + '.' + rem;
}

module.exports = { formatPrice };

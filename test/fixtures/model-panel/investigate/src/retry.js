// Retries fn up to times attempts; returns the first result that passes check.
function withRetry(fn, times, check = () => true) {
  let last;
  for (let i = 0; i < times; i++) {
    last = fn();
    if (check(last)) return last;
  }
  return last;
}

module.exports = { withRetry };

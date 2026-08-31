// Planted over-engineering fixture for the simplification specialist.
// Three deliberate invitations: a hand-rolled date formatter the platform
// ships (native:), an abstract layer with exactly one implementation
// (speculative:), and a config block nothing reads (delete:).

// INVITATION 1 (native:): Intl.DateTimeFormat does all of this in one line.
class DateFormatter {
  constructor(locale) {
    this.locale = locale || 'en-US';
    this.monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
  }

  pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  formatLong(date) {
    const month = this.monthNames[date.getMonth()];
    return `${month} ${date.getDate()}, ${date.getFullYear()}`;
  }

  formatShort(date) {
    return `${this.pad(date.getMonth() + 1)}/${this.pad(date.getDate())}/${date.getFullYear()}`;
  }

  formatTime(date) {
    const hours = date.getHours() % 12 || 12;
    const suffix = date.getHours() >= 12 ? 'PM' : 'AM';
    return `${hours}:${this.pad(date.getMinutes())} ${suffix}`;
  }
}

// INVITATION 2 (speculative:): abstract base with a single implementation.
class AbstractItemStore {
  save(item) {
    throw new Error('not implemented');
  }
  load(id) {
    throw new Error('not implemented');
  }
}

class MemoryItemStore extends AbstractItemStore {
  constructor() {
    super();
    this.items = new Map();
  }
  save(item) {
    this.items.set(item.id, item);
    return item;
  }
  load(id) {
    return this.items.get(id) || null;
  }
}

// INVITATION 3 (delete:): configuration nothing in this file (or repo) reads.
const FORMATTER_CONFIG = {
  enableLegacyMode: false,
  cacheSize: 128,
  strictParsing: true,
  fallbackLocale: 'en-GB',
};

module.exports = { DateFormatter, MemoryItemStore, FORMATTER_CONFIG };

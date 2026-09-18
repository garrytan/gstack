import { Database } from 'bun:sqlite';
import { CounterRepository } from './src/repository';
const db = new Database(':memory:');
const counters = new CounterRepository(db);
counters.set('orders', 2);
console.log(counters.get('orders'), counters.get('orders'), counters.get('missing'));
db.close();

/**
 * Rails autoloads constants, so a Ruby source names no require a spec could
 * follow. The RSpec convention maps it instead: `app/<path>.rb` and
 * `lib/<path>.rb` select `spec/<path>_spec.rb` and `spec/lib/<path>_spec.rb`
 * when that spec exists.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { buildGraph, testsFor } from '../lib/pregate/import-graph';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const fixture = () => { const r = makeFixtureRepo(); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

describe('import graph: RSpec specs mirror app/ and lib/', () => {
  test('app/, a class-named directory and lib/ files select the spec at the conventional path', () => {
    const repo = fixture();
    commit(repo, {
      'app/services/plugins/weather.rb': 'class Plugins::Weather; end\n',
      'app/services/plugins/weather/api.rb': 'class Plugins::Weather::Api; end\n',
      'app/models/user.rb': 'class User; end\n',
      'lib/parser.rb': 'class Parser; end\n',
      'spec/services/plugins/weather_spec.rb': 'RSpec.describe Plugins::Weather do; end\n',
      'spec/services/plugins/weather/api_spec.rb': 'RSpec.describe Plugins::Weather::Api do; end\n',
      'spec/models/user_spec.rb': 'RSpec.describe User do; end\n',
      'spec/lib/parser_spec.rb': 'RSpec.describe Parser do; end\n',
    });
    const g = buildGraph(repo.work);
    expect(testsFor(g, 'app/services/plugins/weather.rb').tests).toEqual(['spec/services/plugins/weather_spec.rb']);
    expect(testsFor(g, 'app/services/plugins/weather/api.rb').tests).toEqual(['spec/services/plugins/weather/api_spec.rb']);
    expect(testsFor(g, 'app/models/user.rb').tests).toEqual(['spec/models/user_spec.rb']);
    expect(testsFor(g, 'lib/parser.rb').tests).toEqual(['spec/lib/parser_spec.rb']);
  });

  test('no edge when the conventional spec does not exist', () => {
    const repo = fixture();
    commit(repo, {
      'app/models/order.rb': 'class Order; end\n',
      'spec/models/user_spec.rb': 'RSpec.describe User do; end\n',
    });
    expect(testsFor(buildGraph(repo.work), 'app/models/order.rb').tests).toEqual([]);
  });
});

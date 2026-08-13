import { describe, expect, it } from 'vitest'; import { normalizeRetention } from './youtubeAnalytics.js';
import { assertReadOnly } from './clickhouseMcp.js';
describe('YouTube retention normalization', () => { it('preserves ratios and derives seconds', () => { const points = normalizeRetention('v', 120, [[.01, 1], [.42, .62], [1, .2]]); expect(points[1]).toMatchObject({ position_ratio: .42, position_seconds: 50.4, audience_watch_ratio: .62 }); }); it('rejects invalid ratios', () => expect(() => normalizeRetention('v', 100, [[1.2, .5]])).toThrow()); });
describe('read-only ClickHouse MCP', () => {
  it('accepts SELECT and WITH queries', () => { expect(() => assertReadOnly('SELECT 1')).not.toThrow(); expect(() => assertReadOnly('WITH recent AS (SELECT 1) SELECT * FROM recent')).not.toThrow(); });
  it('rejects writes and multiple statements', () => { expect(() => assertReadOnly('INSERT INTO videos VALUES (1)')).toThrow(); expect(() => assertReadOnly('SELECT 1; DROP TABLE videos')).toThrow(); });
});

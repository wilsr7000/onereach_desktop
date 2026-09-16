/**
 * lib/weather-tips -- the morning's ONE useful weather sentence (what to
 * wear, what to bring), derived deterministically from a forecast.
 */
import { describe, it, expect } from 'vitest';

const { buildWearTip, layerFor, describeCode } = require('../../lib/weather-tips');

function forecast(overrides = {}) {
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    hourly.push({ time: `2026-09-15T${String(h).padStart(2, '0')}:00`, hour: h, temp: 54 + Math.max(0, 14 - Math.abs(13 - h) * 2), feels: 52 + Math.max(0, 16 - Math.abs(13 - h) * 2), precipProb: 1, code: 1, wind: 8, uv: h >= 11 && h <= 15 ? 6.6 : 1 });
  }
  return {
    unit: 'F',
    windUnit: 'mph',
    location: 'San Francisco',
    current: { temp: 54, feelsLike: 57, humidity: 91, code: 1, desc: 'mainly clear', wind: 4, precipitation: 0 },
    daily: { high: 68.6, low: 53.8, feelsHigh: 69, feelsLow: 51.9, precipProbMax: 2, precipSumInches: 0, code: 45, windMax: 14.8, uvMax: 6.6, sunrise: '2026-09-15T06:51', sunset: '2026-09-15T19:17' },
    hourly,
    ...overrides,
  };
}

const NOW = new Date(2026, 8, 15, 7, 25);

describe('buildWearTip', () => {
  it('the real 2026-09-15 SF morning: light jacket now, shed by afternoon, no rain, sunscreen', () => {
    const tip = buildWearTip(forecast(), { now: NOW, isToday: true });
    expect(tip.headline).toBe('Wear a light jacket or a sweater, bring sunscreen for midday');
    expect(tip.tip).toBe('Wear a light jacket or a sweater, something you can shed by afternoon (feels like 57°F now). Bring sunscreen for midday. No rain expected.');
    expect(tip.spoken).toBe(
      "It feels like 57 right now, so grab a light jacket or a sweater. You'll shed it by afternoon, it climbs to 68. Sunscreen if you are out midday. No rain today. High of 69, low of 54."
    );
    expect(tip.line).toBe('54°F now · high 69°F, low 54°F · a light jacket or a sweater, something you can shed by afternoon · bring sunscreen for midday');
    expect(tip.summary).toContain('Now 54°F and mostly clear in San Francisco');
    expect(tip.facts).toMatchObject({ high: 69, low: 54, rainChance: 2, uvMax: 6.6, sunset: '7:17 PM' });
  });

  it('rain likely -> umbrella, and no "no rain"', () => {
    const f = forecast({ daily: { ...forecast().daily, precipProbMax: 70, precipSumInches: 0.3, uvMax: 2 } });
    f.hourly = f.hourly.map((h) => ({ ...h, precipProb: 60, code: 61, uv: 1 }));
    const tip = buildWearTip(f, { now: NOW });
    expect(tip.tip).toContain('Bring an umbrella.');
    expect(tip.tip).not.toContain('No rain');
    expect(tip.spoken).toContain('Take an umbrella');
    expect(tip.spoken).not.toContain('No rain today');
  });

  it('a chance of rain later -> "just in case"', () => {
    const f = forecast({ daily: { ...forecast().daily, precipProbMax: 35, uvMax: 2 } });
    f.hourly = f.hourly.map((h) => ({ ...h, uv: 1 }));
    const tip = buildWearTip(f, { now: NOW });
    expect(tip.tip).toContain('an umbrella just in case');
    expect(tip.spoken).toMatch(/maybe an umbrella/i);
  });

  it('freezing + snow + wind -> heavy coat, boots, windbreaker', () => {
    const f = forecast({
      current: { temp: 20, feelsLike: 12, code: 71 },
      daily: { high: 28, low: 15, feelsHigh: 20, feelsLow: 8, precipProbMax: 80, precipSumInches: 0.5, code: 73, windMax: 25, uvMax: 1 },
    });
    f.hourly = f.hourly.map((h) => ({ ...h, temp: 20, feels: 12, code: 73, wind: 22, uv: 0, precipProb: 80 }));
    const tip = buildWearTip(f, { now: NOW });
    expect(tip.tip).toContain('Wear a heavy coat, hat and gloves');
    expect(tip.tip).toContain('boots');
    expect(tip.tip).toContain('windbreaker');
    expect(tip.spoken).toContain('bundle up');
  });

  it('hot afternoon with a mild morning keeps short sleeves and cools-off advice only when it drops', () => {
    const f = forecast({ current: { temp: 84, feelsLike: 84, code: 0 }, daily: { high: 92, low: 70, feelsHigh: 94, feelsLow: 68, precipProbMax: 0, precipSumInches: 0, code: 0, windMax: 5, uvMax: 9 } });
    f.hourly = f.hourly.map((h) => ({ ...h, temp: 85, feels: 85, code: 0, uv: 9, wind: 5, precipProb: 0 }));
    const tip = buildWearTip(f, { now: NOW });
    expect(tip.tip).toMatch(/^Wear light clothes, it is hot/);
    expect(tip.tip).toContain('sunscreen');
    expect(tip.tip).not.toContain('shed');
  });

  it('Celsius input converts thresholds but displays in C', () => {
    const f = forecast({ unit: 'C', windUnit: 'kmh', current: { temp: 12, feelsLike: 11, code: 3 }, daily: { high: 20, low: 11, feelsHigh: 20, feelsLow: 10, precipProbMax: 5, precipSumInches: 0, code: 3, windMax: 20, uvMax: 3 } });
    f.hourly = f.hourly.map((h) => ({ ...h, temp: 12, feels: 11, code: 3, uv: 2, wind: 12, precipProb: 2 }));
    const tip = buildWearTip(f, { now: NOW });
    expect(tip.tip).toContain('Wear a jacket'); // 11°C ≈ 52°F
    expect(tip.tip).toContain('11°C');
    expect(tip.line).toContain('12°C now');
  });

  it('forward-looking (tomorrow) uses daily values and future wording', () => {
    const tip = buildWearTip(forecast(), { now: NOW, isToday: false });
    expect(tip.spoken).toMatch(/^Grab a light jacket/);
    expect(tip.spoken).toContain('No rain expected.');
    expect(tip.tip).not.toContain('now)');
  });

  it('fog is called out first', () => {
    const f = forecast({ current: { temp: 54, feelsLike: 53, code: 45 } });
    const tip = buildWearTip(f, { now: NOW });
    expect(tip.tip).toMatch(/^Foggy start\./);
    expect(tip.spoken).toMatch(/^It is foggy out\./);
  });

  it('survives an empty forecast', () => {
    const tip = buildWearTip({}, { now: NOW });
    expect(typeof tip.tip).toBe('string');
    expect(tip.tip.length).toBeGreaterThan(0);
  });

  it('layerFor bands', () => {
    expect(layerFor(30).layer).toContain('heavy coat');
    expect(layerFor(50).layer).toBe('a jacket');
    expect(layerFor(60).layer).toBe('a light jacket or a sweater');
    expect(layerFor(70).layer).toBe('long sleeves');
    expect(layerFor(76).layer).toBe('short sleeves');
    expect(describeCode(45)).toBe('foggy');
    expect(describeCode(95)).toBe('stormy');
    expect(describeCode(null, 'Light Drizzle')).toBe('light drizzle');
  });
});

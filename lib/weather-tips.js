/**
 * Weather tips -- turn a day's forecast into the ONE thing a person getting
 * dressed wants to hear: what to wear and what to bring.
 *
 * Why (2026-09-15): the brief's weather segment reported the current
 * temperature and humidity ("54°F, 89% humidity"), which is true and useless
 * at 7 AM. The useful sentence is "light jacket now, you'll shed it by noon,
 * no rain, sunscreen at midday". That sentence is derived HERE with
 * deterministic rules over real forecast numbers -- never by the composer,
 * which must not invent a temperature or a rain chance.
 *
 * Input (normalised by weather-agent._fetchForecastData):
 *   {
 *     unit: 'F' | 'C',
 *     windUnit: 'mph' | 'kmh',
 *     location: 'San Francisco',
 *     current: { temp, feelsLike, desc, code, humidity, wind, precipitation },
 *     daily:   { high, low, feelsHigh, feelsLow, precipProbMax, precipSumInches,
 *                code, windMax, uvMax, sunrise, sunset },
 *     hourly:  [{ time, hour, temp, feels, precipProb, code, wind, uv }]  // target day
 *   }
 * Thresholds are Fahrenheit / mph; other units are converted first.
 */

'use strict';

const FOG_CODES = new Set([45, 48]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const THUNDER_CODES = new Set([95, 96, 99]);
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toF(t, unit) {
  const n = num(t);
  if (n === null) return null;
  return unit === 'C' ? (n * 9) / 5 + 32 : n;
}

function toMph(w, windUnit) {
  const n = num(w);
  if (n === null) return null;
  return windUnit === 'kmh' ? n / 1.609 : n;
}

function roundTemp(t) {
  const n = num(t);
  return n === null ? null : Math.round(n);
}

/** Short spoken/screen description for a WMO code (fallback: desc string). */
function describeCode(code, desc) {
  const c = num(code);
  if (c !== null) {
    if (c === 0) return 'clear';
    if (c === 1) return 'mostly clear';
    if (c === 2) return 'partly cloudy';
    if (c === 3) return 'overcast';
    if (FOG_CODES.has(c)) return 'foggy';
    if (c >= 51 && c <= 57) return 'drizzly';
    if (c >= 61 && c <= 67) return 'rainy';
    if (SNOW_CODES.has(c)) return 'snowy';
    if (c >= 80 && c <= 82) return 'showery';
    if (THUNDER_CODES.has(c)) return 'stormy';
  }
  return (desc || '').toLowerCase() || 'unsettled';
}

/**
 * The layer the morning calls for, from the feels-like temperature (°F).
 * Returns { layer, spoken } -- `layer` is a noun phrase for the screen,
 * `spoken` a short imperative for the voice.
 */
function layerFor(feelsF) {
  if (feelsF === null) return { layer: 'a light layer', spoken: 'grab a light layer' };
  if (feelsF < 32) return { layer: 'a heavy coat, hat and gloves', spoken: 'bundle up, heavy coat, hat and gloves' };
  if (feelsF < 45) return { layer: 'a warm coat', spoken: 'wear a warm coat' };
  if (feelsF < 55) return { layer: 'a jacket', spoken: 'wear a jacket' };
  if (feelsF < 63) return { layer: 'a light jacket or a sweater', spoken: 'grab a light jacket or a sweater' };
  if (feelsF < 72) return { layer: 'long sleeves', spoken: 'long sleeves will do' };
  if (feelsF < 82) return { layer: 'short sleeves', spoken: 'short sleeves are fine' };
  return { layer: 'light clothes, it is hot', spoken: 'dress light, it is hot' };
}

function fmtTemp(t, unit) {
  const r = roundTemp(t);
  return r === null ? null : `${r}°${unit || 'F'}`;
}

function fmtClock(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Open-Meteo local times come without an offset ("2026-09-15T19:17");
    // take the HH:MM as-is.
    const m = String(iso).match(/T(\d{2}):(\d{2})/);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const mer = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m[2]} ${mer}`;
  }
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/**
 * Build the wear/bring tip.
 *
 * @param {Object} forecast - see module header
 * @param {Object} [opts]
 * @param {Date} [opts.now] - current time (local); used to pick the "leaving now" window
 * @param {boolean} [opts.isToday=true] - false for a forward-looking brief (uses daily min/max)
 * @returns {{ headline, tip, spoken, line, summary, facts }}
 */
function buildWearTip(forecast, opts = {}) {
  const f = forecast || {};
  const unit = f.unit === 'C' ? 'C' : 'F';
  const windUnit = f.windUnit === 'kmh' ? 'kmh' : 'mph';
  const now = opts.now ? new Date(opts.now) : new Date();
  const isToday = opts.isToday !== false;
  const current = f.current || {};
  const daily = f.daily || {};
  const hourly = Array.isArray(f.hourly) ? f.hourly : [];

  // Windows: the next ~3 hours ("leaving now"), and the afternoon peak.
  const nowHour = now.getHours();
  const soon = isToday
    ? hourly.filter((h) => num(h.hour) !== null && h.hour >= nowHour && h.hour <= nowHour + 3)
    : hourly.filter((h) => num(h.hour) !== null && h.hour >= 7 && h.hour <= 10);
  const afternoon = hourly.filter((h) => num(h.hour) !== null && h.hour >= 12 && h.hour <= 17);
  const rest = isToday ? hourly.filter((h) => num(h.hour) !== null && h.hour >= nowHour) : hourly;

  const minOf = (arr, key) => arr.reduce((m, h) => (num(h[key]) !== null && (m === null || h[key] < m) ? h[key] : m), null);
  const maxOf = (arr, key) => arr.reduce((m, h) => (num(h[key]) !== null && (m === null || h[key] > m) ? h[key] : m), null);

  const morningFeelsRaw =
    (isToday && num(current.feelsLike) !== null ? Math.min(current.feelsLike, minOf(soon, 'feels') ?? current.feelsLike) : null) ??
    minOf(soon, 'feels') ??
    daily.feelsLow ??
    daily.low ??
    current.feelsLike ??
    current.temp;
  const afternoonFeelsRaw = maxOf(afternoon, 'feels') ?? daily.feelsHigh ?? daily.high ?? morningFeelsRaw;
  const morningF = toF(morningFeelsRaw, unit);
  const afternoonF = toF(afternoonFeelsRaw, unit);
  const swingF = morningF !== null && afternoonF !== null ? afternoonF - morningF : 0;

  const rainSoon = maxOf(rest.slice(0, 6), 'precipProb') ?? null;
  const rainDay = num(daily.precipProbMax) ?? maxOf(rest, 'precipProb') ?? null;
  const rainInches = num(daily.precipSumInches) ?? 0;
  const codesAhead = rest.map((h) => num(h.code)).filter((c) => c !== null);
  const codeNow = num(current.code);
  const rainCoded = codesAhead.some((c) => RAIN_CODES.has(c)) || (codeNow !== null && RAIN_CODES.has(codeNow));
  const snow = codesAhead.some((c) => SNOW_CODES.has(c)) || (codeNow !== null && SNOW_CODES.has(codeNow));
  const thunder = codesAhead.some((c) => THUNDER_CODES.has(c));
  const fogSoon = (codeNow !== null && FOG_CODES.has(codeNow)) || soon.some((h) => FOG_CODES.has(num(h.code)));
  const windMaxMph = toMph(daily.windMax ?? maxOf(rest, 'wind'), windUnit);
  const uvMax = num(daily.uvMax) ?? maxOf(rest, 'uv');

  const layer = layerFor(morningF);
  const wearParts = [layer.layer];
  const spokenParts = [layer.spoken];
  if (morningF !== null && morningF < 63 && swingF >= 12) {
    wearParts.push('something you can shed by afternoon');
    spokenParts.push(`you'll shed it by afternoon${afternoonF !== null ? `, it climbs to ${roundTemp(afternoonFeelsRaw)}` : ''}`);
  } else if (morningF !== null && morningF >= 63 && swingF <= -8) {
    wearParts.push('bring a layer for later, it cools off');
    spokenParts.push('bring a layer for later, it cools off');
  }

  const bring = [];
  const spokenBring = [];
  if (snow) {
    bring.push('boots');
    spokenBring.push('wear boots, snow is in the forecast');
  } else if ((rainSoon !== null && rainSoon >= 50) || (rainDay !== null && rainDay >= 60) || rainInches >= 0.1 || rainCoded) {
    bring.push('an umbrella');
    spokenBring.push('take an umbrella');
  } else if (rainDay !== null && rainDay >= 25) {
    bring.push('an umbrella just in case');
    spokenBring.push('maybe an umbrella, there is a chance of rain later');
  }
  if (thunder) {
    bring.push('thunderstorms possible');
    spokenBring.push('thunderstorms are possible, stay flexible');
  }
  if (windMaxMph !== null && windMaxMph >= 20) {
    bring.push('a windbreaker, it gets windy');
    spokenBring.push('it gets windy, a windbreaker helps');
  }
  if (uvMax !== null && uvMax >= 6) {
    bring.push('sunscreen for midday');
    spokenBring.push('sunscreen if you are out midday');
  }

  const noRain =
    !snow && !rainCoded && rainInches < 0.1 && (rainDay === null || rainDay < 25);

  const tempNow = fmtTemp(current.temp, unit);
  const feelsNow = fmtTemp(current.feelsLike, unit);
  const high = fmtTemp(daily.high, unit);
  const low = fmtTemp(daily.low, unit);
  const condition = describeCode(isToday ? codeNow ?? daily.code : daily.code, current.desc);
  const sunset = fmtClock(daily.sunset);

  // Screen: one compact sentence group.
  const tipSentences = [];
  tipSentences.push(
    `Wear ${wearParts.join(', ')}${feelsNow && isToday ? ` (feels like ${feelsNow} now)` : ''}.`
  );
  if (bring.length) tipSentences.push(`Bring ${bring.join(', ')}.`);
  if (noRain) tipSentences.push('No rain expected.');
  if (fogSoon) tipSentences.unshift('Foggy start.');
  const tip = tipSentences.join(' ');

  // Voice: the number first ("feels like 57"), then the imperative, then
  // what to bring, then the day's range. Always says whether it will rain.
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const spokenSentences = [];
  if (fogSoon) spokenSentences.push('It is foggy out.');
  const lead = feelsNow && isToday ? `It feels like ${roundTemp(current.feelsLike)} right now, so ${spokenParts[0]}` : cap(spokenParts[0]);
  spokenSentences.push(`${lead}.`);
  if (spokenParts.length > 1) spokenSentences.push(`${cap(spokenParts.slice(1).join(', '))}.`);
  if (spokenBring.length) spokenSentences.push(`${spokenBring.map((s, i) => (i === 0 ? cap(s) : s)).join(', and ')}.`);
  if (noRain) spokenSentences.push(isToday ? 'No rain today.' : 'No rain expected.');
  if (high && low) spokenSentences.push(`High of ${roundTemp(daily.high)}, low of ${roundTemp(daily.low)}.`);
  const spoken = spokenSentences.join(' ');

  const headline = `Wear ${wearParts[0]}${bring.length ? `, bring ${bring[0]}` : ''}`;

  // Facts line for the composer and the dayView section.
  const factBits = [];
  if (isToday && tempNow) factBits.push(`Now ${tempNow}${condition ? ` and ${condition}` : ''}${f.location ? ` in ${f.location}` : ''}`);
  else if (condition) factBits.push(`${condition.charAt(0).toUpperCase() + condition.slice(1)}${f.location ? ` in ${f.location}` : ''}`);
  if (high && low) factBits.push(`high ${high}, low ${low}`);
  if (rainDay !== null) factBits.push(`rain chance ${Math.round(rainDay)}%`);
  if (windMaxMph !== null) factBits.push(`wind up to ${Math.round(daily.windMax ?? windMaxMph)} ${windUnit === 'kmh' ? 'km/h' : 'mph'}`);
  if (uvMax !== null && uvMax >= 3) factBits.push(`UV ${Math.round(uvMax * 10) / 10}`);
  if (sunset) factBits.push(`sunset ${sunset}`);
  const summary = factBits.length ? `${factBits.join(', ')}.` : '';

  const line = [
    tempNow ? `${tempNow} now` : null,
    high && low ? `high ${high}, low ${low}` : null,
    `${wearParts.join(', ')}`,
    bring.length ? `bring ${bring.join(', ')}` : noRain ? 'no rain' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    headline,
    tip,
    spoken,
    line,
    summary,
    facts: {
      unit,
      location: f.location || null,
      tempNow: roundTemp(current.temp),
      feelsNow: roundTemp(current.feelsLike),
      high: roundTemp(daily.high),
      low: roundTemp(daily.low),
      condition,
      rainChance: rainDay !== null ? Math.round(rainDay) : null,
      windMax: windMaxMph !== null ? Math.round(windMaxMph) : null,
      uvMax: uvMax !== null ? Math.round(uvMax * 10) / 10 : null,
      sunset,
      fog: fogSoon,
      swing: Math.round(swingF),
    },
  };
}

module.exports = { buildWearTip, layerFor, describeCode, fmtClock };

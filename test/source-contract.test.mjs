// Issue 006 — the source failure contract, as a reproducible matrix.
//
// This file replaces a scratch probe that could not be re-run by a reviewer (Judge H-12).
// It enumerates the accepted per-adapter data-path map and asserts, for every in-scope
// adapter: a total failure reports, an HTTP 200 whose body IS an error reports, and a
// healthy body does NOT report. It then adds the cases an aggregate sweep cannot see —
// fallback pairs, ADS-B's empty-versus-failed pair, and per-peer retention.
//
// The healthy fixtures matter: a generic `[]` is not a success body for a CSV, XML or HTML
// adapter, and using one produced eight false failures during the build.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const SRC = new URL('../apis/sources/', import.meta.url);
const load = async (name) => import(new URL(`${name}.mjs?c=${Math.random()}`, SRC));

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const text = (t) => new Response(t, { status: 200, headers: { 'content-type': 'text/plain' } });
const fail418 = () => new Response('denied', { status: 418 });
const errorBody = () => json({ error: 'quota exceeded' });

const hasError = (p) => typeof p?.error === 'string' && p.error !== '';

// Format-correct success bodies, per adapter parser.
const SAT = { OBJECT_NAME: 'SAT', NORAD_CAT_ID: 1, OBJECT_ID: '2026-001A', EPOCH: '2026-08-19T00:00:00', COUNTRY_CODE: 'US' };
const HEALTHY = {
  gscpi: () => text('date,v1\n31-Jul-2026,0.15\n31-Aug-2026,0.20\n'),  // parser wants DD-Mon-YYYY
  firms: () => text('latitude,longitude,brightness,acq_date,confidence,frp\n50.1,8.2,320.5,2026-08-19,80,12.3\n'),
  ofac: () => text('<?xml version="1.0"?><sdnList><publshInformation><Publish_Date>08/19/2026</Publish_Date>' +
                   '<Record_Count>1234</Record_Count></publshInformation></sdnList>'),
  kiwisdr: () => text('<html><script>var receivers = [{"location":{"coordinates":[8.2,50.1]},' +
                      '"receivers":[{"name":"rx1","url":"http://x","users":1,"users_max":4}]}];</script></html>'),
  telegram: () => text('<html><div class="tgme_widget_message" data-post="chan/1">' +
                       '<div class="tgme_widget_message_text">hello</div>' +
                       '<time datetime="2026-08-19T00:00:00+00:00"></time></div></html>'),
  who: () => json({ value: [{ Title: 'Outbreak', PublicationDate: '2026-08-19T00:00:00Z', ItemDefaultUrl: '/x', regionscode: 'EURO' }] }),
  yfinance: () => json({ chart: { result: [{ meta: { symbol: '^GSPC', regularMarketPrice: 5000, chartPreviousClose: 4950, currency: 'USD' }, timestamp: [1], indicators: { quote: [{ close: [5000] }] } }] } }),
  'cloudflare-radar': () => json({ result: { annotations: [], summary_0: {}, top_0: [], serie_0: {} }, success: true }),
  space: () => json([SAT, SAT]),
  fred: () => json({ observations: [{ date: '2026-08-01', value: '1.5' }] }),
  eia: () => json({ response: { data: [{ period: '2026-08-01', value: 80.5 }] } }),
};
const defaultHealthy = () => json([]);

// The in-scope adapters, and whether their key arrives as a function argument.
const ADAPTERS = ['adsb', 'bluesky', 'cloudflare-radar', 'comtrade', 'eia', 'epa', 'firms', 'fred',
  'gdelt', 'gscpi', 'kiwisdr', 'ofac', 'opensanctions', 'patents', 'reddit', 'reliefweb', 'safecast',
  'space', 'telegram', 'treasury', 'usaspending', 'who', 'yfinance'];
const ARG_KEYED = new Set(['fred', 'eia']);

let realFetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
  // Adapters gated on env read it at call time; give them all a value so they reach their
  // fetch path. Absence is asserted separately, on the argument-gated adapters, because
  // env.mjs refills any falsy variable from .env and makes env-gated absence unreproducible.
  for (const k of ['FIRMS_MAP_KEY', 'CLOUDFLARE_API_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
                   'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'ADSB_API_KEY']) {
    if (!process.env[k]) process.env[k] = 'test-key';
  }
});
afterEach(() => { globalThis.fetch = realFetch; });

const brief = async (name) => (await load(name)).briefing(ARG_KEYED.has(name) ? 'test-key' : undefined);

describe('every in-scope adapter reports a total failure', () => {
  for (const name of ADAPTERS) {
    test(name, async () => {
      globalThis.fetch = async () => fail418();
      assert.ok(hasError(await brief(name)), `${name} swallowed a total upstream failure`);
    });
  }
});

describe('every in-scope adapter reports an HTTP 200 whose body is an error', () => {
  for (const name of ADAPTERS) {
    test(name, async () => {
      globalThis.fetch = async () => errorBody();
      assert.ok(hasError(await brief(name)), `${name} read a 200 error body as data`);
    });
  }
});

// A healthy fixture must also prove the adapter still PARSES. Asserting only the absence
// of `error` would pass an adapter whose success parser had been deleted (AC-8).
const HEALTHY_FIELD = {
  adsb: (p) => p.status === 'live' || p.status === 'no_key',
  bluesky: (p) => !!p.topics,
  'cloudflare-radar': (p) => !!p.attacks || !!p.outages,
  comtrade: (p) => Array.isArray(p.tradeFlows),
  eia: (p) => !!p.oilPrices,
  epa: (p) => typeof p.totalReadings === 'number',
  firms: (p) => Array.isArray(p.hotspots),
  fred: (p) => Array.isArray(p.indicators) && p.indicators.length > 0,
  gdelt: (p) => typeof p.totalArticles === 'number',
  gscpi: (p) => p.latest !== undefined,
  kiwisdr: (p) => typeof p.totalReceivers === 'number' || Array.isArray(p.receivers) || !!p.status,
  ofac: (p) => !!p.sdnList,
  opensanctions: (p) => Array.isArray(p.recentSearches),
  patents: (p) => typeof p.totalFound === 'number',
  reddit: (p) => !!p.subreddits || p.status === 'no_key',
  reliefweb: (p) => Array.isArray(p.latestReports) || Array.isArray(p.activeDisasters),
  safecast: (p) => Array.isArray(p.sites),
  space: (p) => Array.isArray(p.recentLaunches),
  telegram: (p) => Array.isArray(p.channels) || typeof p.posts === 'number',
  treasury: (p) => Array.isArray(p.debt) || Array.isArray(p.interestRates),
  usaspending: (p) => Array.isArray(p.recentDefenseContracts),
  who: (p) => Array.isArray(p.outbreaks) || p.outbreakError === null,
  yfinance: (p) => !!p.quotes,
};

describe('no in-scope adapter reports on a healthy body, and each still parses', () => {
  for (const name of ADAPTERS) {
    test(name, async () => {
      globalThis.fetch = async () => (HEALTHY[name] ?? defaultHealthy)();
      const p = await brief(name);
      assert.equal(hasError(p), false, `${name} reported an error on a valid body`);
      assert.ok(HEALTHY_FIELD[name](p), `${name} produced no normal parsed field — success parser broken?`);
    });
  }
});

// AC-1 requires timeout/network proof for adapters that call fetch directly, since each has
// its own try/catch rather than inheriting safeFetch's error envelope.
const RAW_FETCH = ['firms', 'gscpi', 'kiwisdr', 'ofac', 'reddit', 'reliefweb', 'telegram', 'usaspending', 'who'];

describe('raw-fetch adapters report a network rejection', () => {
  for (const name of RAW_FETCH) {
    test(name, async () => {
      globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
      assert.ok(hasError(await brief(name)), `${name} swallowed a network rejection`);
    });
  }
});

// Every heterogeneous required path, failed INDEPENDENTLY. Selection is by call index
// (deterministic under Promise.all), but each assertion is semantic: the failure must be
// reported AND the peers that succeeded must survive.
const MULTI_PATH = {
  eia: { calls: 4, survives: (p) => !!p.oilPrices },
  epa: { calls: 4, survives: (p) => typeof p.totalReadings === 'number' },
  ofac: { calls: 2, survives: (p) => !!p.sdnList && !!p.advancedList },
  opensanctions: { calls: 7, survives: (p) => Array.isArray(p.recentSearches) && p.recentSearches.length > 0 },
  treasury: { calls: 2, survives: (p) => Array.isArray(p.debt) || Array.isArray(p.interestRates) },
  space: { calls: 5, survives: (p) => Array.isArray(p.recentLaunches) },
  'cloudflare-radar': { calls: 4, survives: (p) => !!p.outages || !!p.attacks || !!p.anomalies },
  reliefweb: { calls: 2, survives: (p) => !!p.hdxDatasets || Array.isArray(p.activeDisasters) || Array.isArray(p.latestReports) },
  usaspending: { calls: 2, survives: (p) => Array.isArray(p.recentDefenseContracts) || Array.isArray(p.topAgencies) },
};

describe('each required path fails independently, and its peers survive', () => {
  for (const [name, spec] of Object.entries(MULTI_PATH)) {
    for (let pos = 1; pos <= spec.calls; pos++) {
      test(`${name}: path ${pos} of ${spec.calls}`, async () => {
        let n = 0;
        globalThis.fetch = async () => {
          n += 1;
          return n === pos ? fail418() : (HEALTHY[name] ?? defaultHealthy)();
        };
        const p = await brief(name);
        assert.ok(hasError(p), `${name} hid a failure of path ${pos}`);
        assert.ok(spec.survives(p), `${name} discarded surviving peers when path ${pos} failed`);
        // Universal retention proxy: a failed path must not collapse the payload to a bare
        // {source, timestamp, status, error} envelope — that is how space discarded three
        // live feeds (Judge H-11) while still reporting the failure correctly.
        const envelope = new Set(['source', 'timestamp', 'status', 'error']);
        const payloadKeys = Object.keys(p).filter(k => !envelope.has(k));
        assert.ok(payloadKeys.length > 0,
          `${name} collapsed to an error envelope when path ${pos} failed — no payload survived`);
      });
    }
  }
});

describe('cloudflare attack dimensions fail independently', () => {
  // Judge H-13: reporting only when NEITHER dimension survived presented half an attack
  // summary as healthy.
  const good = () => json({ result: { annotations: [], summary_0: { a: 1 }, top_0: [], serie_0: {} }, success: true });
  for (const dim of ['protocol', 'vector']) {
    test(`${dim} fails, the other survives`, async () => {
      globalThis.fetch = async (u) => String(u).includes(`summary/${dim}`) ? fail418() : good();
      const p = await brief('cloudflare-radar');
      assert.ok(hasError(p), `a failed ${dim} dimension must report`);
      const kept = Object.keys(p.attacks || {}).filter(k => k !== 'error');
      assert.ok(kept.length > 0, `the surviving attack dimension was discarded (kept: ${kept})`);
    });
  }
});

describe('fallback chains — a working fallback is not a failure', () => {
  test('adsb: RapidAPI down, public feed delivers', async () => {
    globalThis.fetch = async (u) => String(u).includes('rapidapi')
      ? fail418()
      : json({ ac: [{ hex: 'ae1', flight: 'RCH1', t: 'C17', lat: 50, lon: 8, alt_baro: 30000, gs: 400 }] });
    assert.equal(hasError(await brief('adsb')), false);
  });

  test('adsb: an EMPTY successful feed is a quiet world, not a failure', async () => {
    // The sharpest case in the issue: before the fix, quiet skies and a dead feed were
    // byte-identical, so neither could be fixed without breaking the other.
    globalThis.fetch = async (u) => String(u).includes('rapidapi') ? fail418() : json({ ac: [] });
    assert.equal(hasError(await brief('adsb')), false);
  });

  test('adsb: every transport failing IS a failure', async () => {
    globalThis.fetch = async () => fail418();
    assert.ok(hasError(await brief('adsb')));
  });

  test('reddit: OAuth token down, public route delivers', async () => {
    const post = { data: { title: 'T', score: 1, num_comments: 0, permalink: '/r/x/1', created_utc: 1, subreddit: 'worldnews', author: 'u' } };
    globalThis.fetch = async (u) => String(u).includes('access_token')
      ? new Response('no', { status: 401 })
      : json({ data: { children: [post] } });
    assert.equal(hasError(await brief('reddit')), false);
  });

  const prevYear = new Date().getFullYear() - 1;
  test('comtrade: current year empty, previous-year fallback delivers', async () => {
    globalThis.fetch = async (u) => String(u).includes(`period=${prevYear}`)
      ? json({ data: [{ reporterCode: 842, cmdCode: '2709', primaryValue: 1000, period: prevYear, partnerDesc: 'X', flowDesc: 'Import' }] })
      : json({ data: [] });
    assert.equal(hasError(await brief('comtrade')), false);
  });

  test('comtrade: current year empty and the fallback FAILS is a failure', async () => {
    // Judge H-10: requiring both attempts to error let this report as a quiet healthy source.
    globalThis.fetch = async (u) => String(u).includes(`period=${prevYear}`) ? fail418() : json({ data: [] });
    const p = await brief('comtrade');
    assert.ok(hasError(p), 'a failed fallback must report');
    assert.ok(!JSON.stringify(p.signals).includes('No significant trade anomalies'),
      'the all-clear string must not survive a failed fetch');
  });
});

describe('retention — a partial failure keeps what was obtained', () => {
  test('fred: 1 of 21 series fails, the other 20 survive', async () => {
    globalThis.fetch = async (u) => String(u).includes('series_id=DFF')
      ? fail418()
      : json({ observations: [{ date: '2026-08-01', value: '1.5' }] });
    const p = await brief('fred');
    assert.ok(hasError(p));
    assert.equal(p.indicators.length, 20);
  });

  test('reliefweb: reports fails, the successful disasters peer survives', async () => {
    globalThis.fetch = async (u) => String(u).includes('disasters')
      ? json({ data: [{ fields: { name: 'Flood', status: 'ongoing', date: { created: '2026-08-01' } } }] })
      : fail418();
    const p = await brief('reliefweb');
    assert.ok(hasError(p));
    assert.ok(Array.isArray(p.activeDisasters) && p.activeDisasters.length > 0,
      'the successful peer must not be discarded');
  });

  test('space: launches AND stations fail, military/constellation peers survive', async () => {
    // Judge H-11: an early return discarded every successful peer here.
    globalThis.fetch = async (u) => {
      const s = String(u);
      return (s.includes('last-30-days') || s.includes('GROUP=stations')) ? fail418() : json([SAT, SAT, SAT]);
    };
    const p = await brief('space');
    assert.ok(hasError(p));
    assert.equal(p.militarySatellites, 3, 'a successful military peer must survive');
    assert.ok(p.constellations?.starlink > 0, 'a successful constellation peer must survive');
  });

  test('usaspending: agencies fails, the defense peer survives', async () => {
    globalThis.fetch = async (u) => String(u).includes('toptier_agencies')
      ? fail418()
      : json({ results: [{ Award: 'X', 'Award Amount': 1000, 'Recipient Name': 'R', 'Awarding Agency': 'DoD', 'Start Date': '2026-08-01' }] });
    const p = await brief('usaspending');
    assert.ok(hasError(p));
    assert.ok(Array.isArray(p.recentDefenseContracts));
  });
});

describe('configured absence is not a failure', () => {
  test('fred and eia with no key: zero calls, absence status, no error', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return fail418(); };
    for (const name of ['fred', 'eia']) {
      const p = await (await load(name)).briefing(undefined);
      assert.equal(hasError(p), false, `${name} must not report an error when unconfigured`);
      assert.equal(p.status, 'no_key', `${name} must use an absence status`);
    }
    assert.equal(calls, 0, 'an unconfigured adapter must not contact its upstream');
  });
});

describe('the sweep keeps an errored source payload', () => {
  test('fullBriefing retains all 29 sources when 25 of them fail', async () => {
    // The load-bearing filter is `s.data !== undefined`, not `s.status === 'ok'`. Reverting
    // it drops every errored source's payload — which is how promoting one failed FRED
    // indicator would have deleted the other twenty.
    globalThis.fetch = async () => fail418();
    const { fullBriefing } = await import('../apis/briefing.mjs');
    const out = await fullBriefing();
    assert.equal(Object.keys(out.timing).length, 29);
    assert.equal(Object.keys(out.sources).length, 29,
      'an errored source must keep its payload in `sources`');
    assert.ok(out.crucix.sourcesFailed > 20, 'the sweep should report the failures honestly');
  });
});

// --- content retention -------------------------------------------------------------
// The envelope proxy above is a coarse guard. It cannot see a survivor being replaced by
// null, which is the loss AC-1 and design M-9 actually forbid — so these assert a value
// derived from a sentinel body, per required path.

describe('content retention — surviving peers keep their VALUES', () => {
  test('eia: WTI fails, brent/gas/inventory values survive', async () => {
    // Judge H-12: an oracle that checks only `!!p.oilPrices` stays green while every
    // sibling value is replaced by null.
    const series = (v) => json({ response: { data: [{ period: '2026-08-01', value: v }] } });
    globalThis.fetch = async (u) => String(u).includes('RWTC') ? fail418() : series(77.7);
    const p = await brief('eia');
    assert.ok(hasError(p), 'a failed WTI path must report');
    assert.equal(p.oilPrices?.brent?.value, 77.7, 'brent value lost');
    assert.equal(p.gasPrice?.value, 77.7, 'gas value lost');
    assert.equal(p.inventories?.crudeStocks?.value, 77.7, 'crude stocks value lost');
  });

  test('gscpi: a healthy body yields a parsed latest value', async () => {
    // The previous fixture used a date format the parser rejects, so `latest` was null and
    // `p.latest !== undefined` passed anyway — AC-8 proved nothing for this adapter.
    globalThis.fetch = async () => HEALTHY.gscpi();
    const p = await brief('gscpi');
    assert.equal(hasError(p), false);
    assert.ok(p.latest && p.latest.value === 0.2, `expected the parsed latest value, got ${JSON.stringify(p.latest)}`);
  });

  test('comtrade: primary FAILS and the fallback succeeds — no error', async () => {
    // The other half of AC-1's pair: r3 only covered a primary that succeeded EMPTY.
    const prevYear = new Date().getFullYear() - 1;
    globalThis.fetch = async (u) => String(u).includes(`period=${prevYear}`)
      ? json({ data: [{ reporterCode: 842, cmdCode: '2709', primaryValue: 4242, period: prevYear, partnerDesc: 'X', flowDesc: 'Import' }] })
      : fail418();
    const p = await brief('comtrade');
    assert.equal(hasError(p), false, 'a failed primary with a working fallback is not a failure');
    assert.ok(p.tradeFlows.length > 0, 'the fallback data must survive');
  });
});

describe('homogeneous fan-outs — one member fails, its peers keep their records', () => {
  const post = { data: { title: 'SENTINEL', score: 1, num_comments: 0, permalink: '/r/x/1', created_utc: 1, subreddit: 'worldnews', author: 'u' } };
  const cases = {
    bluesky: { fail: 'q=', body: () => json({ posts: [{ uri: 'at://1', cid: 'c', author: { handle: 'h' }, record: { text: 'SENTINEL', createdAt: '2026-08-19T00:00:00Z' }, likeCount: 1, repostCount: 0 }] }),
               survives: (p) => JSON.stringify(p.topics).includes('SENTINEL') },
    safecast: { fail: 'distance', body: () => json([{ value: 30, unit: 'cpm', captured_at: '2026-08-19T00:00:00Z' }]),
                survives: (p) => p.sites.some(s => s.recentReadings > 0) },
    patents: { fail: 'q=', body: () => json({ patents: [{ patent_id: '1', patent_title: 'SENTINEL', patent_date: '2026-08-01' }] }),
               survives: (p) => JSON.stringify(p.recentPatents).includes('SENTINEL') },
    yfinance: { fail: '%5EGSPC', body: () => HEALTHY.yfinance(),
                survives: (p) => Object.keys(p.quotes).length > 1 },
  };
  for (const [name, c] of Object.entries(cases)) {
    test(`${name}: one member fails, peers retain records`, async () => {
      let n = 0;
      globalThis.fetch = async () => { n += 1; return n === 1 ? fail418() : c.body(); };
      const p = await brief(name);
      assert.ok(hasError(p), `${name} hid a single failed member`);
      assert.ok(c.survives(p), `${name} lost its surviving members' records`);
    });
  }
});

describe('content retention — the four adapters whose survivors were unasserted', () => {
  // Judge H-12 r4: each of these kept the correct top-level `error` and return shape while
  // silently hollowing a successful peer, and every existing oracle stayed green because it
  // asserted a container or a numeric type rather than a value.

  test('firms: one region fails, the surviving regions keep their detections', async () => {
    const csv = () => text('latitude,longitude,brightness,acq_date,confidence,frp\n50.1,8.2,340.5,2026-08-19,80,25.3\n');
    let n = 0;
    globalThis.fetch = async () => { n += 1; return n === 1 ? fail418() : csv(); };
    const p = await brief('firms');
    assert.ok(hasError(p), 'a failed hotspot region must report');
    const detected = (p.hotspots || []).reduce((a, h) => a + (h.totalDetections || 0), 0);
    assert.ok(detected > 0, `surviving regions lost their detections (total ${detected})`);
  });

  // Both directions: failing only the broad pull cannot detect the broad pull being
  // hollowed, because the fixture already removed it. Each side must be the survivor once.
  for (const [label, failAt] of [['broad pull', 1], ['an analyte query', 2]]) {
    test(`epa: ${label} fails, the other path's readings survive`, async () => {
      const reading = () => json([{ value: 31, unit: 'cpm', captured_at: '2026-08-19T00:00:00Z' }]);
      let n = 0;
      globalThis.fetch = async () => { n += 1; return n === failAt ? fail418() : reading(); };
      const p = await brief('epa');
      assert.ok(hasError(p), 'a failed EPA path must report');
      assert.ok(p.totalReadings > 0, `surviving readings were discarded (totalReadings ${p.totalReadings})`);
    });
  }

  test('usaspending: agencies fails, the defense AWARD survives — not just an array', async () => {
    globalThis.fetch = async (u) => String(u).includes('toptier_agencies')
      ? fail418()
      : json({ results: [{ 'Award ID': 'A1', 'Award Amount': 9999, 'Recipient Name': 'SENTINEL CORP', 'Awarding Agency': 'DoD', 'Start Date': '2026-08-01' }] });
    const p = await brief('usaspending');
    assert.ok(hasError(p));
    assert.equal(p.recentDefenseContracts?.[0]?.recipient, 'SENTINEL CORP',
      'the surviving defense award was hollowed out');
  });

  test('telegram: one channel fails, the surviving channels keep their posts', async () => {
    const html = () => text('<html><div class="tgme_widget_message" data-post="chan/1">' +
      '<div class="tgme_widget_message_text">SENTINEL POST</div>' +
      '<time datetime="2026-08-19T00:00:00+00:00"></time></div></html>');
    // Fail the first CHANNEL scrape, not the first request — with a token configured the
    // first request is the Bot API call, whose failure is a working fallback, not a failure.
    let scraped = 0;
    globalThis.fetch = async (u) => {
      if (!String(u).includes('t.me')) return fail418();
      scraped += 1;
      return scraped === 1 ? fail418() : html();
    };
    const p = await brief('telegram');
    assert.ok(hasError(p), 'a failed channel must report');
    assert.ok(p.totalPosts > 0, `surviving channels lost their posts (totalPosts ${p.totalPosts})`);
    assert.ok(JSON.stringify(p.topPosts || []).includes('SENTINEL'),
      'the surviving channels\' post CONTENT was discarded');
    assert.ok(p.channelsReachable > 0 && p.channelsReachable < p.channelsMonitored,
      `expected a partial outage, got ${p.channelsReachable}/${p.channelsMonitored} reachable`);
  });

  test('telegram: Bot API fails, the scrape fallback delivers — no error', async () => {
    // The fallback pair AC-1 requires for telegram, which was missing.
    const html = () => text('<html><div class="tgme_widget_message" data-post="chan/1">' +
      '<div class="tgme_widget_message_text">SENTINEL POST</div>' +
      '<time datetime="2026-08-19T00:00:00+00:00"></time></div></html>');
    globalThis.fetch = async (u) => String(u).includes('api.telegram.org') ? fail418() : html();
    const p = await brief('telegram');
    assert.equal(hasError(p), false, 'a working scrape fallback is not a failure');
  });
});

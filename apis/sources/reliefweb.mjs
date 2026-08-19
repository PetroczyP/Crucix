// ReliefWeb — UN OCHA humanitarian crisis tracking
// Requires approved appname since Nov 2025. Register at https://apidoc.reliefweb.int/parameters#appname
// Falls back to HDX (Humanitarian Data Exchange) if ReliefWeb API returns 403.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.reliefweb.int/v1';
// Register your own appname at https://apidoc.reliefweb.int/parameters#appname
// and replace this value. Without an approved appname the API returns 403.
const APPNAME = process.env.RELIEFWEB_APPNAME || 'crucix';

const HDX_BASE = 'https://data.humdata.org/api/3/action';

// POST-based search for reports (ReliefWeb API v1 POST format)
async function rwPost(endpoint, body) {
  const url = `${BASE}/${endpoint}?appname=${APPNAME}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Crucix/1.0',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    return await res.json();
  } catch (e) {
    return { error: e.message, source: url };
  }
}

// Search recent reports via ReliefWeb API (POST method)
export async function searchReports(opts = {}) {
  const { query = '', limit = 15 } = opts;
  const body = {
    limit,
    fields: {
      include: [
        'title',
        'date.created',
        'country.name',
        'disaster_type.name',
        'url_alias',
        'source.name',
      ],
    },
    sort: ['date.created:desc'],
  };
  if (query) {
    body.query = { value: query };
  }
  return rwPost('reports', body);
}

// Get active disasters via ReliefWeb API (POST method)
export async function getDisasters(opts = {}) {
  const { limit = 15 } = opts;
  const body = {
    limit,
    fields: {
      include: ['name', 'date.created', 'country.name', 'type.name', 'status'],
    },
    filter: {
      field: 'status',
      value: 'ongoing',
    },
    sort: ['date.created:desc'],
  };
  return rwPost('disasters', body);
}

// Fallback: search HDX (Humanitarian Data Exchange) for crisis datasets
async function hdxFallback(limit = 15) {
  const data = await safeFetch(
    `${HDX_BASE}/package_search?q=crisis+OR+disaster+OR+emergency&rows=${limit}&sort=metadata_modified+desc`
  );
  if (data?.result?.results) {
    return data.result.results.map(pkg => ({
      title: pkg.title,
      date: pkg.metadata_modified,
      source: pkg.dataset_source || pkg.organization?.title,
      countries: pkg.groups?.map(g => g.display_name),
      url: `https://data.humdata.org/dataset/${pkg.name}`,
    }));
  }
  return [];
}

// Briefing — get latest humanitarian crises
export async function briefing() {
  const [reports, disasters] = await Promise.all([
    searchReports({ limit: 15 }),
    getDisasters({ limit: 15 }),
  ]);

  // ReliefWeb is deliberately NOT a fallback chain: reports and disasters are
  // two independently-required peers run in parallel. Either one failing
  // means the briefing did not fully deliver, but it must never cost us the
  // peer that DID succeed.
  const reportsFailed = !!reports?.error;
  const disastersFailed = !!disasters?.error;
  const rwFailed = reportsFailed || disastersFailed;

  let latestReports = [];
  let activeDisasters = [];
  let hdxDatasets = [];

  if (!reportsFailed) {
    latestReports = (reports?.data || []).map(r => ({
      title: r.fields?.title,
      date: r.fields?.date?.created,
      countries: r.fields?.country?.map(c => c.name),
      disasterType: r.fields?.disaster_type?.map(d => d.name),
      source: r.fields?.source?.map(s => s.name),
      url: r.fields?.url_alias
        ? `https://reliefweb.int${r.fields.url_alias}`
        : null,
    }));
  }
  if (!disastersFailed) {
    activeDisasters = (disasters?.data || []).map(d => ({
      name: d.fields?.name,
      date: d.fields?.date?.created,
      countries: d.fields?.country?.map(c => c.name),
      type: d.fields?.type?.map(t => t.name),
      status: d.fields?.status,
    }));
  }
  if (rwFailed) {
    // HDX is ADDITIONAL fallback data for the failed peer — it supplements,
    // it never erases the error or the peer that succeeded.
    hdxDatasets = await hdxFallback(15);
  }

  const rwErrorMessage = [reportsFailed ? reports.error : null, disastersFailed ? disasters.error : null]
    .filter(Boolean)
    .join('; ');

  return {
    source: rwFailed ? 'ReliefWeb (UN OCHA) + HDX (fallback for failed peer)' : 'ReliefWeb (UN OCHA)',
    timestamp: new Date().toISOString(),
    ...(rwFailed
      ? {
          error: rwErrorMessage,
          rwError: rwErrorMessage,
          rwNote: 'ReliefWeb API requires an approved appname since Nov 2025. Set RELIEFWEB_APPNAME env var after registering at https://apidoc.reliefweb.int/parameters#appname',
          hdxDatasets,
        }
      : {}),
    latestReports,
    activeDisasters,
  };
}

if (process.argv[1]?.endsWith('reliefweb.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}

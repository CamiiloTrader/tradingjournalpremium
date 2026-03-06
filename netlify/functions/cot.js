// netlify/functions/cot.js
// Proxy server-side para la API de CFTC — elimina restricciones CORS
// Deploy en Netlify → disponible como /api/cot

const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TradingJournal/1.0',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseCFTCRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const l = rows[0], p = rows[1] || null;

  const mmL = +l.m_money_positions_long_all    || 0;
  const mmS = +l.m_money_positions_short_all   || 0;
  const prL = +l.prod_merc_positions_long_all  || 0;
  const prS = +l.prod_merc_positions_short_all || 0;

  if (mmL === 0 && mmS === 0) return null;

  const mmNet   = mmL - mmS;
  const prodNet = prL - prS;
  const pmmNet  = p ? ((+p.m_money_positions_long_all   || 0) - (+p.m_money_positions_short_all  || 0)) : mmNet;
  const pprod   = p ? ((+p.prod_merc_positions_long_all || 0) - (+p.prod_merc_positions_short_all || 0)) : prodNet;

  // Convertir fecha CFTC (martes) al lunes de esa semana
  const dateStr = l.report_date_as_yyyy_mm_dd || '';
  let reportDate = dateStr.slice(0, 10);
  if (reportDate) {
    const d   = new Date(reportDate + 'T12:00:00');
    const dow = d.getDay();
    const diff = dow === 1 ? 0 : dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + diff);
    reportDate = d.toISOString().slice(0, 10);
  }

  return {
    mmNet:      Math.round(mmNet),
    mmChange:   Math.round(mmNet  - pmmNet),
    prodNet:    Math.round(prodNet),
    prodChange: Math.round(prodNet - pprod),
    reportDate,
  };
}

exports.handler = async function(event, context) {
  const HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Dataset: Disaggregated Futures Only — Gold COMEX (código 088691)
  const ENDPOINTS = [
    'https://publicreporting.cftc.gov/resource/jun7-fc8e.json?cftc_commodity_code=088691&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=2',
    // Fallback: filter by name in case commodity code changes
    'https://publicreporting.cftc.gov/resource/jun7-fc8e.json?$where=market_and_exchange_names%20like%20%27%25GOLD%25%27&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=2',
  ];

  for (const url of ENDPOINTS) {
    try {
      const { status, body } = await fetchJson(url);
      if (status !== 200) continue;
      const result = parseCFTCRows(body);
      if (result) {
        return {
          statusCode: 200,
          headers: HEADERS,
          body: JSON.stringify(result),
        };
      }
    } catch (e) {
      console.error('CFTC endpoint error:', e.message);
    }
  }

  return {
    statusCode: 503,
    headers: HEADERS,
    body: JSON.stringify({ error: 'COT data unavailable', endpoints_tried: ENDPOINTS.length }),
  };
};

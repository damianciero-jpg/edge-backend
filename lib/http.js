function buildMeta(meta = {}, req = null) {
  return {
    requestId: req?.id || null,
    timestamp: new Date().toISOString(),
    ...meta,
  };
}

function ok(res, { text = '', meta = {}, data = {} } = {}) {
  return res.json({ ok: true, text, error: null, meta: buildMeta(meta, res.req), ...data });
}

function fail(res, status, { text = '', error = 'Request failed', meta = {}, data = {} } = {}) {
  return res.status(status).json({ ok: false, text, error, meta: buildMeta(meta, res.req), ...data });
}

module.exports = { ok, fail };

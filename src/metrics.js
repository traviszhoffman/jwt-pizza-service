const os = require('os');
const config = require('./config');

// ─── In-memory metric stores ───────────────────────────────────────────────

const httpMetrics = {
  totalRequests: 0,
  byMethod: { GET: 0, POST: 0, PUT: 0, DELETE: 0 },
};

const authMetrics = {
  successfulLogins: 0,
  failedLogins: 0,
};

const userMetrics = {
  activeUsers: new Map(), // track by userId/IP with last activity timestamp
};

const purchaseMetrics = {
  pizzasSold: 0,
  creationFailures: 0,
  totalRevenue: 0,
  factoryLatencySum: 0,
  factoryLatencyCount: 0,
};

const latencyMetrics = {
  endpointLatencies: {}, // { '[GET] /api/order': { sum, count } }
};

let previousCpuSnapshot = captureCpuSnapshot();

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Express middleware — attach to app.use() to track all requests.
 * Tracks HTTP method counts, total requests, active users, and endpoint latency.
 */
function requestTracker(req, res, next) {
  const start = Date.now();
  const method = req.method.toUpperCase();

  httpMetrics.totalRequests++;
  if (method in httpMetrics.byMethod) {
    httpMetrics.byMethod[method]++;
  }

  // Track active users by userId (if authenticated) or IP fallback
  const userId = req.user?.id || req.ip;
  if (userId) userMetrics.activeUsers.set(userId, Date.now());


  res.on('finish', () => {
    const latencyMs = Date.now() - start;
    const key = `[${method}] ${req.route?.path || req.path}`;

    if (!latencyMetrics.endpointLatencies[key]) {
      latencyMetrics.endpointLatencies[key] = { sum: 0, count: 0 };
    }
    latencyMetrics.endpointLatencies[key].sum += latencyMs;
    latencyMetrics.endpointLatencies[key].count++;
  });

  next();
}

/**
 * Call after an auth attempt.
 * @param {boolean} success - whether the login succeeded
 */
function authAttempt(success) {
  if (success) {
    authMetrics.successfulLogins++;
  } else {
    authMetrics.failedLogins++;
  }
}

/**
 * Call after a pizza purchase attempt.
 * @param {boolean} success      - whether the factory succeeded
 * @param {number}  latencyMs    - round-trip time to factory in ms
 * @param {number}  price        - total price of the order (0 on failure)
 * @param {number}  count        - number of pizzas ordered
 */
function pizzaPurchase(success, latencyMs, price, count = 1) {
  if (success) {
    purchaseMetrics.pizzasSold += count;
    purchaseMetrics.totalRevenue += price;
  } else {
    purchaseMetrics.creationFailures++;
  }
  purchaseMetrics.factoryLatencySum += latencyMs;
  purchaseMetrics.factoryLatencyCount++;
}

// ─── System metrics helpers ────────────────────────────────────────────────

function captureCpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  return { idle, total };
}

function getCpuUsagePercentage() {
  const current = captureCpuSnapshot();
  const totalDelta = current.total - previousCpuSnapshot.total;
  const idleDelta = current.idle - previousCpuSnapshot.idle;

  previousCpuSnapshot = current;

  if (totalDelta <= 0) {
    return 0;
  }

  const busyDelta = totalDelta - idleDelta;
  return parseFloat(((busyDelta / totalDelta) * 100).toFixed(2));
}

function getMemoryUsagePercentage() {
  const total = os.totalmem();
  const used = total - os.freemem();
  return parseFloat(((used / total) * 100).toFixed(2));
}

// ─── OTel metric builder ───────────────────────────────────────────────────

function createMetric(metricName, metricValue, metricUnit, metricType, valueType, attributes = {}) {
  const source = config?.metrics?.source || 'jwt-pizza-service';
  const allAttributes = { ...attributes, source };

  const metric = {
    name: metricName,
    unit: metricUnit,
    [metricType]: {
      dataPoints: [
        {
          [valueType]: metricValue,
          timeUnixNano: Date.now() * 1_000_000,
          attributes: Object.entries(allAttributes).map(([key, value]) => ({
            key,
            value: { stringValue: String(value) },
          })),
        },
      ],
    },
  };

  if (metricType === 'sum') {
    metric[metricType].aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
    metric[metricType].isMonotonic = true;
  }

  return metric;
}

function sendToGrafana(metrics) {
  if (!config?.metrics?.endpointUrl || !config?.metrics?.accountId || !config?.metrics?.apiKey) {
    return;
  }

  const body = {
    resourceMetrics: [
      {
        scopeMetrics: [{ metrics }],
      },
    ],
  };

  fetch(config.metrics.endpointUrl, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`,
      'Content-Type': 'application/json',
    },
  })
    .then(async (res) => {
      if (res.ok) {
        return;
      }

      let responseBody = '';
      try {
        responseBody = await res.text();
      } catch {
        responseBody = '<unable to read response body>';
      }

      console.error(
        `[metrics] Failed to send to Grafana: HTTP ${res.status} ${res.statusText}; body=${responseBody}`
      );
    })
    .catch((err) => {
      console.error('[metrics] Failed to send to Grafana (network/runtime):', err);
    });
}

// ─── Periodic reporting ────────────────────────────────────────────────────

function sendMetricsPeriodically(periodMs = 60_000) {
  const timer = setInterval(() => {
    try {
      const metrics = [];

      // ── HTTP request counts ──────────────────────────────────────────────
      metrics.push(createMetric('http_requests_total', httpMetrics.totalRequests, '1', 'sum', 'asInt'));
      for (const [method, count] of Object.entries(httpMetrics.byMethod)) {
        metrics.push(createMetric('http_requests_by_method', count, '1', 'sum', 'asInt', { method }));
      }

      // ── Auth ─────────────────────────────────────────────────────────────
      metrics.push(createMetric('auth_attempts_success', authMetrics.successfulLogins, '1', 'sum', 'asInt'));
      metrics.push(createMetric('auth_attempts_failed',  authMetrics.failedLogins,    '1', 'sum', 'asInt'));

      // ── Active users ─────────────────────────────────────────────────────
      const now = Date.now();
      const activeWindowSeconds = 300; // 5-minute window
      let activeUserCount = 0;
      
      userMetrics.activeUsers.forEach((lastActivityTime) => {
        if (now - lastActivityTime < activeWindowSeconds * 1000) {
          activeUserCount++;
        }
      });
      
      metrics.push(
        createMetric('active_users', activeUserCount, '1', 'gauge', 'asInt')
      );
      // Clean up stale entries (older than 10 minutes)
      const staleThresholdMs = 600 * 1000;
      userMetrics.activeUsers.forEach((lastActivityTime, userId) => {
        if (now - lastActivityTime > staleThresholdMs) {
          userMetrics.activeUsers.delete(userId);
        }
      });

      // ── System ───────────────────────────────────────────────────────────
      metrics.push(createMetric('cpu_usage_percent',    getCpuUsagePercentage(),    '%', 'gauge', 'asDouble'));
      metrics.push(createMetric('memory_usage_percent', getMemoryUsagePercentage(), '%', 'gauge', 'asDouble'));

      // ── Pizza purchases ──────────────────────────────────────────────────
      metrics.push(createMetric('pizzas_sold',              purchaseMetrics.pizzasSold,         '1', 'sum', 'asInt'));
      metrics.push(createMetric('pizza_creation_failures',  purchaseMetrics.creationFailures,   '1', 'sum', 'asInt'));
      metrics.push(createMetric('pizza_revenue_total',      purchaseMetrics.totalRevenue,       'USD', 'sum', 'asDouble'));

      const avgFactoryLatency =
        purchaseMetrics.factoryLatencyCount > 0
          ? purchaseMetrics.factoryLatencySum / purchaseMetrics.factoryLatencyCount
          : 0;
      metrics.push(createMetric('pizza_factory_latency_ms', avgFactoryLatency, 'ms', 'gauge', 'asDouble'));

      // ── Endpoint latency ─────────────────────────────────────────────────
      for (const [endpoint, { sum, count }] of Object.entries(latencyMetrics.endpointLatencies)) {
        const avgMs = count > 0 ? sum / count : 0;
        metrics.push(createMetric('endpoint_latency_ms', avgMs, 'ms', 'gauge', 'asDouble', { endpoint }));
      }

      sendToGrafana(metrics);
    } catch (err) {
      console.error('[metrics] Error building metrics payload:', err);
    }
  }, periodMs);

  // Don't keep the event loop alive just for telemetry in tests/shutdown.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

// Start reporting immediately when this module is loaded
sendMetricsPeriodically(60_000);

module.exports = { requestTracker, authAttempt, pizzaPurchase };

const config = require('./config');

class Logger {
  httpLogger = (req, res, next) => {
    let send = res.send;
    res.send = (resBody) => {
      const logData = {
        authorized: !!req.headers.authorization,
        path: req.originalUrl,
        method: req.method,
        statusCode: res.statusCode,
        reqBody: req.body,
        resBody: resBody,
      };
      const level = this.statusToLogLevel(res.statusCode);
      this.log(level, 'http', logData);
      res.send = send;
      return res.send(resBody);
    };
    next();
  };

  log(level, type, logData) {
    const labels = { component: config.logging.source, level: level, type: type };
    const values = [this.nowString(), this.sanitize(logData)];
    const logEvent = { streams: [{ stream: labels, values: [values] }] };

    this.sendLogToGrafana(logEvent);
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  nowString() {
    return (Math.floor(Date.now()) * 1000000).toString();
  }

  sanitizeValue(value, keyName = '') {
    const sensitiveKeys = ['password', 'token', 'jwt', 'authorization', 'apikey', 'api_key', 'session'];
    const isSensitiveKey = sensitiveKeys.some((k) => keyName.toLowerCase().includes(k));

    if (value === null || value === undefined) {
      return value;
    }

    if (isSensitiveKey) {
      return '*****';
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item));
    }

    if (typeof value === 'object') {
      const sanitized = {};
      for (const [k, v] of Object.entries(value)) {
        sanitized[k] = this.sanitizeValue(v, k);
      }
      return sanitized;
    }

    if (typeof value === 'string') {
      return value
        .replace(/Bearer\s+[A-Za-z0-9\-_.=]+/gi, 'Bearer *****')
        .replace(/("(?:password|token|jwt|authorization|session)"\s*:\s*")([^"]+)(")/gi, '$1*****$3')
        .replace(/(\\"(?:password|token|jwt|authorization|session)\\"\s*:\s*\\")([^\\"]+)(\\")/gi, '$1*****$3')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '*****');
    }

    return value;
  }

  sanitize(logData) {
    return JSON.stringify(this.sanitizeValue(logData));
  }

  sendLogToGrafana(event) {
    const body = JSON.stringify(event);
    fetch(`${config.logging.endpointUrl}`, {
      method: 'post',
      body: body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.logging.accountId}:${config.logging.apiKey}`,
      },
    }).then((res) => {
      if (!res.ok) console.log('Failed to send log to Grafana');
    });
  }

  dbLogger(sqlQuery) {
    const logData = { sql: sqlQuery };
    this.log('info', 'db', logData);
  }

  factoryLogger(orderInfo) {
    const logData = { orderInfo };
    this.log('info', 'factory', logData);
  }

  unhandledErrorLogger(error) {
    const logData = {
      message: error.message,
      stack: error.stack,
      statusCode: error.statusCode,
    };
    this.log('error', 'exception', logData);
  }
}

module.exports = new Logger();

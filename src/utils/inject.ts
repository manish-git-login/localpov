/**
 * Returns the JavaScript snippet to inject into HTML pages.
 * This script captures:
 *   - Console output (error, warn, log, info)
 *   - Network requests (fetch + XHR) with status, timing, response bodies for errors
 *   - Unhandled errors and promise rejections
 *   - Screenshots on demand (via html2canvas or canvas capture)
 *
 * Sends everything to the LocalPOV server via WebSocket.
 */
export function getInjectScript(_wsUrl?: string): string {
  // Minified-ish but readable. Runs in the user's browser.
  // Always uses location.host so it works even if the port changes (auto-fallback)
  return `
<script data-localpov-inject>
(function() {
  if (window.__localpov_injected) return;
  window.__localpov_injected = true;

  var WS_URL = "ws://" + location.host + "/__localpov__/ws/browser";
  var ws = null;
  var queue = [];
  var MAX_QUEUE = 100;

  function connect() {
    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = function() {
        while (queue.length) ws.send(queue.shift());
      };
      ws.onclose = function() {
        ws = null;
        setTimeout(connect, 3000);
      };
      ws.onerror = function() { ws = null; };
    } catch(e) {}
  }
  connect();

  function send(data) {
    var msg = JSON.stringify(data);
    if (ws && ws.readyState === 1) {
      ws.send(msg);
    } else if (queue.length < MAX_QUEUE) {
      queue.push(msg);
    }
  }

  // ── Console capture ──
  var origConsole = {};
  ['error','warn','log','info','debug'].forEach(function(level) {
    origConsole[level] = console[level];
    console[level] = function() {
      origConsole[level].apply(console, arguments);
      var args = Array.prototype.slice.call(arguments);
      var message = args.map(function(a) {
        if (a instanceof Error) return a.message + '\\n' + (a.stack || '');
        if (typeof a === 'object') {
          try { return JSON.stringify(a, null, 2).slice(0, 1000); } catch(e) { return String(a); }
        }
        return String(a);
      }).join(' ');
      send({
        type: 'console',
        level: level,
        message: message.slice(0, 2000),
        url: location.href,
        ts: Date.now()
      });
    };
  });

  // ── Unhandled errors ──
  window.addEventListener('error', function(e) {
    send({
      type: 'error',
      message: e.message || String(e),
      source: (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0),
      stack: e.error && e.error.stack ? e.error.stack : null,
      url: location.href,
      ts: Date.now()
    });
  });

  window.addEventListener('unhandledrejection', function(e) {
    var msg = e.reason instanceof Error ? e.reason.message : String(e.reason || 'Unhandled promise rejection');
    var stack = e.reason instanceof Error ? e.reason.stack : null;
    send({
      type: 'error',
      message: msg,
      stack: stack,
      source: 'unhandledrejection',
      url: location.href,
      ts: Date.now()
    });
  });

  // ── Fetch capture ──
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
      var method = (init && init.method) || (input && input.method) || 'GET';
      var startTime = Date.now();

      // Skip localpov's own requests
      if (url.indexOf('__localpov__') !== -1) return origFetch.apply(this, arguments);

      return origFetch.apply(this, arguments).then(function(response) {
        var entry = {
          type: 'network',
          method: method.toUpperCase(),
          url: url.slice(0, 500),
          status: response.status,
          statusText: response.statusText,
          duration: Date.now() - startTime,
          ts: Date.now()
        };

        // Capture response body for errors
        if (response.status >= 400) {
          response.clone().text().then(function(body) {
            entry.responseBody = body.slice(0, 5000);
            send(entry);
          }).catch(function() { send(entry); });
        } else {
          send(entry);
        }
        return response;
      }).catch(function(err) {
        send({
          type: 'network',
          method: method.toUpperCase(),
          url: url.slice(0, 500),
          status: 0,
          error: err.message || 'Network error',
          duration: Date.now() - startTime,
          ts: Date.now()
        });
        throw err;
      });
    };
  }

  // ── XHR capture ──
  var origXHROpen = XMLHttpRequest.prototype.open;
  var origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__lpov = { method: method, url: String(url).slice(0, 500), startTime: 0 };
    return origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    var xhr = this;
    if (xhr.__lpov) {
      // Skip localpov's own requests
      if (xhr.__lpov.url.indexOf('__localpov__') !== -1) {
        return origXHRSend.apply(this, arguments);
      }
      xhr.__lpov.startTime = Date.now();
      xhr.addEventListener('loadend', function() {
        var entry = {
          type: 'network',
          method: (xhr.__lpov.method || 'GET').toUpperCase(),
          url: xhr.__lpov.url,
          status: xhr.status,
          statusText: xhr.statusText,
          duration: Date.now() - xhr.__lpov.startTime,
          ts: Date.now()
        };
        if (xhr.status >= 400) {
          entry.responseBody = String(xhr.responseText || '').slice(0, 5000);
        }
        send(entry);
      });
      xhr.addEventListener('error', function() {
        send({
          type: 'network',
          method: (xhr.__lpov.method || 'GET').toUpperCase(),
          url: xhr.__lpov.url,
          status: 0,
          error: 'XHR network error',
          duration: Date.now() - xhr.__lpov.startTime,
          ts: Date.now()
        });
      });
    }
    return origXHRSend.apply(this, arguments);
  };

  // ── Screenshot on demand ──
  // Server can request a screenshot via WS message { type: 'take-screenshot' }
  function takeScreenshot() {
    // Try html2canvas if loaded, otherwise use basic canvas capture
    if (window.html2canvas) {
      window.html2canvas(document.body, { useCORS: true, logging: false, scale: 0.5 }).then(function(canvas) {
        send({ type: 'screenshot', data: canvas.toDataURL('image/jpeg', 0.6), ts: Date.now() });
      }).catch(function() {
        fallbackScreenshot();
      });
    } else {
      fallbackScreenshot();
    }
  }

  function fallbackScreenshot() {
    // Inject html2canvas dynamically on first screenshot request
    var script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    script.onload = function() {
      window.html2canvas(document.body, { useCORS: true, logging: false, scale: 0.5 }).then(function(canvas) {
        send({ type: 'screenshot', data: canvas.toDataURL('image/jpeg', 0.6), ts: Date.now() });
      }).catch(function(e) {
        send({ type: 'console', level: 'warn', message: 'LocalPOV: screenshot failed: ' + e.message, ts: Date.now() });
      });
    };
    script.onerror = function() {
      send({ type: 'console', level: 'warn', message: 'LocalPOV: could not load html2canvas for screenshots', ts: Date.now() });
    };
    document.head.appendChild(script);
  }

  // Listen for server commands
  function setupWsListener() {
    if (!ws) { setTimeout(setupWsListener, 1000); return; }
    ws.addEventListener('message', function(e) {
      try {
        var cmd = JSON.parse(e.data);
        if (cmd.type === 'take-screenshot') takeScreenshot();
      } catch(err) {}
    });
  }
  setupWsListener();

})();
</script>`;
}

// Served to a page of the computer that is open on the phone. The page was written for the computer, where
// `localhost` and `127.0.0.1` are the computer itself; on the phone they are the phone. The calls aimed there go instead to
// the phone service, which passes them on to that port of the computer.
(function () {
  "use strict";
  var PREFIX = "/__mango_loopback/";
  var HOSTS = ["localhost", "127.0.0.1"];

  function rewrite(input, socket) {
    var url;
    try {
      url = new URL(String(input), location.href);
    } catch (e) {
      return input;
    }
    var plain = url.protocol === "http:" || (socket && url.protocol === "ws:");
    if (!plain || HOSTS.indexOf(url.hostname) < 0 || url.origin === location.origin) return input;
    var own = new URL(location.href);
    own.protocol = socket ? "ws:" : "http:";
    return own.origin + PREFIX + url.hostname + "/" + (url.port || "80") + url.pathname + url.search;
  }

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      var self = this;
      if (typeof Request === "undefined" || !(input instanceof Request)) {
        var asked = String(input);
        var next = rewrite(asked, false);
        return nativeFetch.call(this, next === asked ? input : next, init);
      }
      var url = rewrite(input.url, false);
      if (url === input.url || input.bodyUsed) return nativeFetch.call(this, input, init);
      // A Request cannot change its address: the new one takes its settings. Its body goes as bytes, because a stream as a
      // body needs `duplex` and HTTP/2, which this server does not speak.
      var options = {
        method: input.method,
        headers: input.headers,
        credentials: input.credentials,
        cache: input.cache,
        redirect: input.redirect,
        referrerPolicy: input.referrerPolicy,
        integrity: input.integrity,
        keepalive: input.keepalive,
        signal: input.signal,
      };
      if (input.mode !== "navigate") options.mode = input.mode;
      var send = function (body) {
        if (body !== undefined) options.body = body;
        return nativeFetch.call(self, new Request(url, options), init);
      };
      return input.body === null ? send() : input.clone().arrayBuffer().then(send);
    };
  }

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = rewrite(url, false);
    return nativeOpen.apply(this, args);
  };

  function wrap(name, socket) {
    var Native = window[name];
    if (!Native) return;
    window[name] = new Proxy(Native, {
      construct: function (target, args, newTarget) {
        var next = args.slice();
        next[0] = rewrite(args[0], socket);
        return Reflect.construct(target, next, newTarget);
      },
    });
  }
  wrap("WebSocket", true);
  wrap("EventSource", false);
})();

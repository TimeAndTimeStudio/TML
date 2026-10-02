// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

function splitPath(pattern) {
  return String(pattern).split('/').filter((segment) => segment.length > 0);
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function matchSegments(routeSegments, pathSegments) {
  const params = {};

  for (let i = 0; i < routeSegments.length; i += 1) {
    const routeSegment = routeSegments[i];

    if (routeSegment === '*') {
      params['*'] = pathSegments.slice(i).map((segment) => decodeSegment(segment) ?? segment).join('/');
      return params;
    }

    const pathSegment = pathSegments[i];
    if (pathSegment === undefined) return null;

    if (routeSegment.startsWith(':')) {
      const decoded = decodeSegment(pathSegment);
      if (decoded === null || decoded === '') return null;
      params[routeSegment.slice(1)] = decoded;
      continue;
    }

    if (routeSegment !== pathSegment) return null;
  }

  if (pathSegments.length !== routeSegments.length) return null;
  return params;
}

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
    routes.push({
      method: String(method).toUpperCase(),
      pattern,
      segments: splitPath(pattern),
      handler,
    });
    return router;
  }

  const router = {
    add,
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    patch: (pattern, handler) => add('PATCH', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    match(method, pathname) {
      const upperMethod = String(method).toUpperCase();
      const pathSegments = splitPath(pathname);
      const allowed = new Set();

      for (const route of routes) {
        const params = matchSegments(route.segments, pathSegments);
        if (!params) continue;

        if (route.method === upperMethod) {
          return { handler: route.handler, params, pattern: route.pattern };
        }
        allowed.add(route.method);
      }

      if (allowed.size > 0) return { allowed: [...allowed].sort() };
      return null;
    },
    list() {
      return routes.map((route) => `${route.method} ${route.pattern}`);
    },
  };

  return router;
}

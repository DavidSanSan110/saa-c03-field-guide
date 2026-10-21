// CloudFront Function for the site, run on every viewer request (runtime cloudfront-js-2.0).
//
// The site is a folder of static files in S3, so S3 knows nothing about "directory indexes":
//   /guide/          is served from /guide/index.html
//   /guide           is redirected to /guide/ (a path whose last segment has no dot is a folder)
//   /_astro/x.js     is served as it is
// With a custom domain the function also sends visitors of the *.cloudfront.net name to the domain.
//
// Terraform replaces the placeholder in the next line with the domain name, or with an empty
// string when the lab has no domain. The file is kept to the subset that both CloudFront and
// Node's vm module run (var, function, no arrow functions), so the tests can run it as it is.
var canonicalHost = '__CANONICAL_HOST__';

// The query string of the request as CloudFront sends it, in the order the keys arrive. Values are
// copied as received: nothing is encoded or decoded here.
function queryString(querystring) {
  var parts = [];
  var keys = Object.keys(querystring || {});
  for (var i = 0; i < keys.length; i++) {
    var entry = querystring[keys[i]];
    var items = entry.multiValue !== undefined ? entry.multiValue : [entry];
    for (var j = 0; j < items.length; j++) {
      var value = items[j].value === undefined ? '' : items[j].value;
      parts.push(keys[i] + '=' + value);
    }
  }
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

function redirect(location) {
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: { location: { value: location } },
  };
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var qs = queryString(request.querystring);
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  var isFolderWithoutSlash = !uri.endsWith('/') && lastSegment.indexOf('.') === -1;

  // One hop: the redirect to the domain already carries the slash a folder needs.
  if (canonicalHost !== '' && host.endsWith('.cloudfront.net')) {
    return redirect('https://' + canonicalHost + uri + (isFolderWithoutSlash ? '/' : '') + qs);
  }
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }
  if (isFolderWithoutSlash) {
    return redirect(uri + '/' + qs);
  }
  return request;
}

// Nava Analytics — GA4 event tracking for CTA clicks
(function () {
  var pieceName = (typeof piece !== 'undefined' && piece && piece.name) ? piece.name : '';

  function trackCta(label) {
    if (typeof gtag === 'undefined') return;
    gtag('event', 'cta_click', {
      piece_name: pieceName,
      page_path: window.location.pathname,
      cta_label: label
    });
  }

  // index.html — BEGIN link → collection_enter
  var beginLink = Array.from(document.querySelectorAll('a')).find(function (a) {
    return a.href.indexOf('suri-hanging-earrings.html') !== -1;
  });
  if (beginLink) {
    beginLink.addEventListener('click', function () {
      if (typeof gtag === 'undefined') return;
      gtag('event', 'collection_enter', {
        page_path: window.location.pathname
      });
    });
  }

  // Product pages — "Order" nav link
  var orderLink = document.querySelector('#orderNavLink');
  if (orderLink) {
    orderLink.addEventListener('click', function () {
      trackCta('nav_order');
    });
  }

  // Product pages — "Begin an order" CTA
  var ctaLink = document.querySelector('#ctaBtn');
  if (ctaLink) {
    ctaLink.addEventListener('click', function () {
      trackCta('begin_an_order');
    });
  }
})();

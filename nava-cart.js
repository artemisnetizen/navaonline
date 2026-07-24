/* ───────────────────────────────────────────────
   NAVA — SHARED CART (Shopify Storefront API)
   Loaded on all piece pages + cart.html.
   Cart object lives in Shopify; only the cart ID
   is stored locally (localStorage), avoiding any
   cross-domain cookie dependency.
─────────────────────────────────────────────── */

const SHOPIFY_DOMAIN = "nava-online-2-2.myshopify.com";
const STOREFRONT_API_VERSION = "2026-04";
const STOREFRONT_PUBLIC_TOKEN = "ba84d407fe47ada4720931ed35b6d62b";

const STOREFRONT_ENDPOINT = `https://${SHOPIFY_DOMAIN}/api/${STOREFRONT_API_VERSION}/graphql.json`;
const CART_ID_KEY = "nava_cart_id";

/* ── LOW-LEVEL GRAPHQL CALL ── */
async function storefrontFetch(query, variables) {
  const res = await fetch(STOREFRONT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": STOREFRONT_PUBLIC_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) {
    console.error("Storefront API error:", json.errors);
    throw new Error(json.errors[0]?.message || "Storefront API error");
  }
  return json.data;
}

/* ── CART ID HELPERS ── */
function getStoredCartId() {
  return localStorage.getItem(CART_ID_KEY);
}
function storeCartId(id) {
  localStorage.setItem(CART_ID_KEY, id);
}
function clearStoredCartId() {
  localStorage.removeItem(CART_ID_KEY);
}

/* ── CART FRAGMENT (reused across mutations/queries) ── */
const CART_FIELDS = `
  id
  checkoutUrl
  totalQuantity
  cost {
    totalAmount { amount currencyCode }
  }
  lines(first: 50) {
    edges {
      node {
        id
        quantity
        merchandise {
          ... on ProductVariant {
            id
            title
            product { title handle }
            image { url altText }
            price { amount currencyCode }
          }
        }
      }
    }
  }
`;

/* ── CREATE A NEW CART WITH ONE LINE ── */
async function createCart(variantId, qty) {
  variantId = toVariantGid(variantId);
  const query = `
    mutation CartCreate($lines: [CartLineInput!]) {
      cartCreate(input: { lines: $lines }) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }
  `;
  const data = await storefrontFetch(query, {
    lines: [{ merchandiseId: variantId, quantity: qty }]
  });
  const cart = data.cartCreate.cart;
  storeCartId(cart.id);
  return cart;
}

/* ── ADD A LINE TO EXISTING CART (creates one if none exists) ── */
function toVariantGid(variantId) {
  const str = String(variantId);
  return str.startsWith("gid://") ? str : `gid://shopify/ProductVariant/${str}`;
}

/* Reads the currently selected size chip live from the DOM (mirrors how
   shopifyVariantId is re-read live on every click, to avoid staleness). */
function getSelectedSizeLineAttributes() {
  const sizeRow = document.getElementById('sizeRow') || document.querySelector('.size-row');
  if (!sizeRow || sizeRow.offsetParent === null) return undefined;
  const selChip = sizeRow.querySelector('.szchip.sel');
  if (!selChip) return undefined;
  const size = selChip.dataset.s || selChip.textContent.trim();
  if (!size) return undefined;
  return [{ key: "Size", value: size }];
}

async function addToCart(variantId, qty) {
  qty = qty || 1;
  variantId = toVariantGid(variantId);
  const sizeAttributes = getSelectedSizeLineAttributes();
  const existingId = getStoredCartId();
  if (!existingId) {
    return createCart(variantId, qty);
  }
  const query = `
    mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }
  `;
  try {
    const line = { merchandiseId: variantId, quantity: qty };
    if (sizeAttributes) line.attributes = sizeAttributes;
    const data = await storefrontFetch(query, {
      cartId: existingId,
      lines: [line]
    });
    if (data.cartLinesAdd.userErrors?.length) {
      throw new Error(data.cartLinesAdd.userErrors[0].message);
    }
    return data.cartLinesAdd.cart;
  } catch (err) {
    // Stored cart ID may be stale/expired — start a fresh cart
    clearStoredCartId();
    return createCart(variantId, qty);
  }
}

/* ── FETCH CURRENT CART (for cart.html + nav badge) ── */
async function getCart() {
  const cartId = getStoredCartId();
  if (!cartId) return null;
  const query = `
    query CartQuery($cartId: ID!) {
      cart(id: $cartId) { ${CART_FIELDS} }
    }
  `;
  try {
    const data = await storefrontFetch(query, { cartId });
    if (!data.cart) {
      clearStoredCartId();
      return null;
    }
    return data.cart;
  } catch (err) {
    clearStoredCartId();
    return null;
  }
}

/* ── UPDATE LINE QUANTITY ── */
async function updateLineQty(lineId, qty) {
  const cartId = getStoredCartId();
  if (!cartId) return null;
  const query = `
    mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
      cartLinesUpdate(cartId: $cartId, lines: $lines) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }
  `;
  const data = await storefrontFetch(query, {
    cartId,
    lines: [{ id: lineId, quantity: qty }]
  });
  if (data.cartLinesUpdate.userErrors?.length) {
    throw new Error(data.cartLinesUpdate.userErrors[0].message);
  }
  return data.cartLinesUpdate.cart;
}

/* ── REMOVE A LINE ── */
async function removeLine(lineId) {
  const cartId = getStoredCartId();
  if (!cartId) return null;
  const query = `
    mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
      cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
        cart { ${CART_FIELDS} }
        userErrors { message }
      }
    }
  `;
  const data = await storefrontFetch(query, { cartId, lineIds: [lineId] });
  if (data.cartLinesRemove.userErrors?.length) {
    throw new Error(data.cartLinesRemove.userErrors[0].message);
  }
  return data.cartLinesRemove.cart;
}

/* ── CHECKOUT URL ── */
async function getCheckoutUrl() {
  const cart = await getCart();
  return cart ? cart.checkoutUrl : null;
}

/* ── NAV BADGE (call on every page load) ── */
async function updateCartBadge() {
  const badgeEl = document.getElementById("cartBadge");
  if (!badgeEl) return;
  const cart = await getCart();
  const count = cart ? cart.totalQuantity : 0;
  badgeEl.textContent = count > 0 ? count : "";
  badgeEl.style.display = count > 0 ? "flex" : "none";
}

/* ── TOAST (call after addToCart resolves) ── */
function showToast(message) {
  let toast = document.getElementById("navaToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "navaToast";
    toast.className = "nava-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove("show"), 2000);
}

document.addEventListener("DOMContentLoaded", updateCartBadge);

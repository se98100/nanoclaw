#!/usr/bin/env node
/**
 * picnic-api.js — Picnic online grocery helper using the picnic-api npm package.
 * https://github.com/MRVDH/picnic-api
 *
 * Usage:
 *   node picnic-api.js login <email> <password> <auth-file> [country]
 *   node picnic-api.js generate-2fa <auth-file>
 *   node picnic-api.js verify-2fa <otp-code> <auth-file>
 *   node picnic-api.js check-session <auth-file>
 *   node picnic-api.js search <query> <auth-file>
 *   node picnic-api.js add <product-id> <qty> <auth-file>
 *   node picnic-api.js cart <auth-file>
 *   node picnic-api.js clear <auth-file>
 *
 * country: "DE" (default) or "NL"
 * Exit codes: 0 = success, 1 = error
 * All commands print a JSON result line to stdout.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEPS = '/app/picnic-deps/node_modules';
const PicnicClient = require(path.join(DEPS, 'picnic-api'));

function ok(data) {
  console.log(JSON.stringify({ status: 'ok', ...data }));
}

function fail(msg, extra = {}) {
  console.log(JSON.stringify({ status: 'error', message: msg, ...extra }));
  process.exit(1);
}

function loadAuth(authFile) {
  if (!fs.existsSync(authFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch {
    return null;
  }
}

function saveAuth(authFile, data) {
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify(data, null, 2));
}

function getClient(authFile) {
  const auth = loadAuth(authFile);
  if (!auth || !auth.authKey) return null;
  return new PicnicClient({
    countryCode: (auth.country || 'DE').toUpperCase(),
    authKey: auth.authKey,
  });
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdLogin(email, password, authFile, country) {
  const countryCode = (country || 'DE').toUpperCase();
  const client = new PicnicClient({ countryCode });

  let result;
  try {
    result = await client.auth.login(email, password);
  } catch (err) {
    return fail(`Login failed: ${err.message}`);
  }

  // Save authKey (may be a preliminary key if 2FA is required)
  saveAuth(authFile, { authKey: result.authKey, country: countryCode });

  if (result.second_factor_authentication_required) {
    ok({
      message: 'Login requires 2FA. Run generate-2fa to send an OTP code via SMS.',
      requires2FA: true,
      userId: result.user_id,
    });
  } else {
    ok({ message: 'Login successful', userId: result.user_id });
  }
}

async function cmdGenerate2FA(authFile) {
  const client = getClient(authFile);
  if (!client) return fail('Not logged in — run login first');

  try {
    await client.auth.generate2FACode('SMS');
    ok({ message: 'OTP code sent via SMS. Run verify-2fa <code> to complete login.' });
  } catch (err) {
    fail(`Failed to generate 2FA code: ${err.message}`);
  }
}

async function cmdVerify2FA(code, authFile) {
  const auth = loadAuth(authFile);
  if (!auth || !auth.authKey) return fail('Not logged in — run login first');

  const client = new PicnicClient({
    countryCode: (auth.country || 'DE').toUpperCase(),
    authKey: auth.authKey,
  });

  let result;
  try {
    result = await client.auth.verify2FACode(code);
  } catch (err) {
    return fail(`2FA verification failed: ${err.message}`);
  }

  // Save updated authKey from 2FA response
  saveAuth(authFile, { authKey: result.authKey, country: auth.country || 'DE' });
  ok({ message: '2FA verified. Login complete.' });
}

async function cmdCheckSession(authFile) {
  const client = getClient(authFile);
  if (!client) return fail('No auth file or token missing');

  try {
    const user = await client.user.getDetails();
    ok({ message: 'Session valid', userId: user.customer_id || user.id });
  } catch (err) {
    fail(`Session expired or invalid: ${err.message}`);
  }
}

async function cmdSearch(query, authFile) {
  const client = getClient(authFile);
  if (!client) return fail('Not logged in');

  let results;
  try {
    results = await client.catalog.search(query);
  } catch (err) {
    return fail(`Search failed: ${err.message}`);
  }

  // results is an array of SellingUnit objects extracted via JSONPath
  const items = (results || []).slice(0, 8).map((unit) => {
    const price = unit.display_price != null ? unit.display_price / 100 : null;
    // Decorators may contain a PRICE_TAG with original price for discounts
    const priceTag = unit.decorators?.find((d) => d.type === 'PRICE_TAG');
    const originalPrice = priceTag?.display_price != null ? priceTag.display_price / 100 : null;
    const discount =
      price != null && originalPrice != null && originalPrice > price
        ? Math.round((1 - price / originalPrice) * 100)
        : 0;
    return {
      id: unit.id,
      name: unit.name,
      unitSize: unit.unit_quantity,
      price,
      originalPrice,
      discount,
      isOffer: discount > 0,
    };
  });

  ok({ items });
}

async function cmdAdd(productId, qty, authFile) {
  const client = getClient(authFile);
  if (!client) return fail('Not logged in');

  try {
    await client.cart.addProductToCart(productId, parseInt(qty, 10));
    ok({ message: `Added ${qty}x ${productId} to cart` });
  } catch (err) {
    fail(`Add to cart failed: ${err.message}`);
  }
}

async function cmdCart(authFile) {
  const client = getClient(authFile);
  if (!client) return fail('Not logged in');

  let cart;
  try {
    cart = await client.cart.getCart();
  } catch (err) {
    return fail(`Could not get cart: ${err.message}`);
  }

  const items = (cart.items || []).map((item) => ({
    id: item.id,
    name: item.name,
    qty: item.decorators?.find((d) => d.type === 'QUANTITY')?.quantity ?? 1,
    price: item.display_price != null ? item.display_price / 100 : null,
  }));

  const total = cart.total_price != null ? cart.total_price / 100 : null;
  ok({ items, total });
}

async function cmdClear(authFile) {
  const client = getClient(authFile);
  if (!client) return fail('Not logged in');

  try {
    await client.cart.clearCart();
    ok({ message: 'Cart cleared' });
  } catch (err) {
    fail(`Could not clear cart: ${err.message}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const [, , cmd, ...args] = process.argv;

(async () => {
  switch (cmd) {
    case 'login':
      await cmdLogin(args[0], args[1], args[2], args[3]);
      break;
    case 'generate-2fa':
      await cmdGenerate2FA(args[0]);
      break;
    case 'verify-2fa':
      await cmdVerify2FA(args[0], args[1]);
      break;
    case 'check-session':
      await cmdCheckSession(args[0]);
      break;
    case 'search':
      await cmdSearch(args[0], args[1]);
      break;
    case 'add':
      await cmdAdd(args[0], args[1], args[2]);
      break;
    case 'cart':
      await cmdCart(args[0]);
      break;
    case 'clear':
      await cmdClear(args[0]);
      break;
    default:
      fail(
        `Unknown command: ${cmd}. Use: login | generate-2fa | verify-2fa | check-session | search | add | cart | clear`,
      );
  }
})().catch((err) => {
  fail(`Unhandled error: ${err.message}`);
});

---
name: picnic-shopping
description: Fill your Picnic online shopping cart from a shopping list. Searches products, detects discounts, adds best matches to cart. The user then reviews and confirms the order. Use when the user sends a grocery or household shopping list and Picnic shopping is enabled.
---

# Picnic Online Shopping Assistant

You fill the user's Picnic shopping cart from a shopping list. For each item you find the best available product — preferring discounted/promotional prices — and add it to the cart. The user then opens the Picnic app or picnic.app to review the cart and confirm the order.

## API Helper

All Picnic operations use the included helper (no browser needed — Picnic has no bot protection):

```bash
API="/home/node/.claude/skills/picnic-shopping/picnic-api.js"
AUTH="/workspace/group/picnic-shopping/auth.json"
```

The script outputs a JSON line: `{"status":"ok",...}` or `{"status":"error","message":"..."}`.
Check `status` after every call. Exit code 1 means error.

---

## Access Control

**First thing**: check the `NANOCLAW_PICNIC_ENABLED` environment variable:

```bash
echo $NANOCLAW_PICNIC_ENABLED
```

- If absent or not `true`: reply *"Picnic shopping is not configured for this group. Ask the admin to enable it."* and stop.
- If `true`: proceed.

---

## State & Config

All state lives in `/workspace/group/picnic-shopping/`:

```
/workspace/group/picnic-shopping/
├── config.json       ← country and user preferences (created during setup)
├── auth.json         ← saved auth token (created after first login)
└── last-cart.json    ← summary of last shopping run
```

**config.json format:**
```json
{
  "country": "de",
  "preferBio": false,
  "preferDiscounted": true
}
```

Supported countries: `"de"` (Germany), `"nl"` (Netherlands).

**purchase-history.json format** — updated automatically after each successful cart fill:
```json
{
  "items": [
    {
      "query": "latte intero",
      "searchTerm": "vollmilch",
      "name": "Weihenstephan Frische Vollmilch 3,5%",
      "id": "12345",
      "count": 5,
      "lastBought": "2026-03-10"
    }
  ]
}
```

Ensure the directory exists:
```bash
mkdir -p /workspace/group/picnic-shopping
```

---

## Mode 1 — Setup

Triggered when user says "setup picnic", "configura picnic", or when `config.json` doesn't exist.

### Step 1: Get country

Ask the user which country their Picnic account is in: Germany (`de`) or Netherlands (`nl`). Default to `de` if not specified.

### Step 2: Save config

Write `/workspace/group/picnic-shopping/config.json` with the chosen country.

### Step 3: Login

Run the login command (credentials come from environment variables):

```bash
API="/home/node/.claude/skills/picnic-shopping/picnic-api.js"
AUTH="/workspace/group/picnic-shopping/auth.json"

node "$API" login "$PICNIC_EMAIL" "$PICNIC_PASSWORD" "$AUTH" "$(node -e "try{const c=require('/workspace/group/picnic-shopping/config.json');console.log(c.country||'de')}catch{console.log('de')}")"
```

**If result is `{"status":"ok","requires2FA":true,...}`** (2FA required):
1. Generate OTP via SMS:
   ```bash
   node "$API" generate-2fa "$AUTH"
   ```
2. Tell the user: *"Picnic richiede un codice OTP — ti ho mandato un SMS. Mandami il codice."*
3. When the user sends the code:
   ```bash
   node "$API" verify-2fa "<OTP_CODE>" "$AUTH"
   ```
4. If `{"status":"ok",...}`: login complete.

**If result is `{"status":"ok",...}`** (no 2FA): tell the user *"Login Picnic effettuato con successo!"*

**If result is `{"status":"error","message":"Login failed",...}`**:
- Ask the user to verify that `PICNIC_EMAIL` and `PICNIC_PASSWORD` are set correctly in the `.env` file.

### Step 4: Confirm

Tell the user: *"Setup completato! Mandami una lista della spesa (es. 'latte, pane, uova 6, pomodori') e riempirò il tuo carrello su Picnic."*

---

## Mode 2 — Fill Cart

Main mode. Triggered when the user sends a shopping list.

**Example triggers:** "fai la spesa: latte, pane, uova", "aggiungi al carrello: ...", "compra su picnic: ..."

### Step 1: Parse the shopping list

Extract individual items with quantities. Examples:
- "latte intero 2L x2" → `{query: "vollmilch 2L", qty: 2}`
- "uova grandi 10" → `{query: "eier 10 stück", qty: 1}`
- "formaggio parmigiano" → `{query: "parmesan", qty: 1}`
- "vino rosso secco" → `{query: "rotwein trocken", qty: 1}`

For DE accounts, translate Italian/English food names to German for better search results (see Translation Reference below). For NL accounts, use Dutch or English.

### Step 2: Load config and ensure session

```bash
API="/home/node/.claude/skills/picnic-shopping/picnic-api.js"
AUTH="/workspace/group/picnic-shopping/auth.json"
CONFIG="/workspace/group/picnic-shopping/config.json"
```

Read `config.json`. If missing, run Setup first.

Check session:
```bash
node "$API" check-session "$AUTH"
```

If `status` is `error` → run the login step from Mode 1, then continue.

### Step 3: Search each item

For each item, search the Picnic catalog:

```bash
node "$API" search "<SEARCH_QUERY>" "$AUTH"
```

Returns `{"status":"ok","items":[...]}` where each item has:
- `id` — product ID (used for adding to cart)
- `name` — product name
- `unitSize` — package size
- `price` — current price in EUR
- `originalPrice` — original price (if discounted)
- `discount` — discount percentage (0 if none)
- `isOffer` — true if on promotion

**Select the best product** from results:
1. Filter: name must be relevant to the query
2. If `preferBio=true` (from config): prefer products with "Bio" / "Biologisch" in the name
3. **Priority**: highest discount % → lowest price → first result
4. Note the chosen product id, name, price, discount %

### Step 4: Add each item to cart

For each selected product:

```bash
node "$API" add "<PRODUCT_ID>" <QTY> "$AUTH"
```

After each result, record: `✅ <productName> (€<price>, -<discount>%)` or `❌ <item> — not found`.

### Step 5: Get cart total

```bash
node "$API" cart "$AUTH"
```

### Step 6: Check purchase history for missing usual items

Load `/workspace/group/picnic-shopping/purchase-history.json` (if it exists).

Build the set of **current run queries** (the normalized item names the user just asked for).

Find history items where:
- `count >= 2` (bought at least twice before)
- The item's `query` does **not** loosely match any current-run query

These are **missing usual items** — the user typically buys them but didn't include them this time.

If there are missing usual items, build a numbered list and include it in the final summary message:

```
mcp__nanoclaw__send_message(text: "🛒 *Carrello Picnic aggiornato!*\n\n✅ *Aggiunti:*\n• <product> €<price> (-<discount>%)\n...\n\n❌ *Non trovati:* <items>\n\n💰 *Totale stimato: €<total>*\n\n💡 *Di solito compri anche:*\n1. Latte intero (acquistato 5 volte)\n2. Pane (acquistato 3 volte)\n...\n\nVuoi aggiungere qualcuno di questi? Rispondi con i numeri (es. \"1 3\") oppure \"no\" per saltare.\n\n📱 Altrimenti, apri l'app Picnic per scegliere la finestra di consegna e confermare l'ordine.")
```

If there are **no** missing usual items (or no history yet), send the standard summary without the suggestions section:

```
mcp__nanoclaw__send_message(text: "🛒 *Carrello Picnic aggiornato!*\n\n✅ *Aggiunti:*\n• <product> €<price> (-<discount>%)\n...\n\n❌ *Non trovati:* <items>\n\n💰 *Totale stimato: €<total>*\n\n📱 Apri l'app Picnic per scegliere la finestra di consegna e confermare l'ordine.")
```

### Step 7: Update purchase history

After sending the summary (regardless of whether suggestions were sent), update `purchase-history.json`:

- For each item successfully added to the cart this run:
  - If the item's query already exists in history: increment `count` and update `lastBought`
  - If it's new: append an entry with `count: 1` and today's date as `lastBought`
- Write the updated JSON back to `/workspace/group/picnic-shopping/purchase-history.json`

Save a summary to `/workspace/group/picnic-shopping/last-cart.json`.

---

## Mode 3 — Show Cart

When user asks "mostra carrello", "cosa c'è nel carrello", "cart status":

```bash
API="/home/node/.claude/skills/picnic-shopping/picnic-api.js"
AUTH="/workspace/group/picnic-shopping/auth.json"

node "$API" cart "$AUTH"
```

Format and send the cart contents as a message.

---

## Mode 4 — Add Suggested Items (follow-up after suggestions)

Triggered when the user replies to a suggestions message with numbers or "no".

**Examples:** "1 2", "aggiungi 1 e 3", "sì tutti", "no grazie", "no"

### Step 1: Parse the user's reply

- If the reply is a rejection ("no", "no grazie", "skip", etc.): reply *"Ok, nessun problema! Apri l'app Picnic per confermare l'ordine."* and stop.
- If the reply is "tutti" / "all" / "sì tutti": treat it as selecting all suggested numbers.
- Otherwise: extract the numbers mentioned.

### Step 2: Load the pending suggestions

Read the suggestions list that was sent. The agent must keep track (in working memory or `last-cart.json`) of which numbered items were offered. Match the user's chosen numbers to the corresponding history items.

### Step 3: Search and add the selected items

For each selected history item:
1. Search using the stored `searchTerm` (or `query` if `searchTerm` is absent):
   ```bash
   node "$API" search "<searchTerm>" "$AUTH"
   ```
2. Pick the best match (same logic as Mode 2 Step 3 — prefer discounted, prefer same product if `id` is in history).
3. Add to cart:
   ```bash
   node "$API" add "<PRODUCT_ID>" 1 "$AUTH"
   ```

### Step 4: Report and update history

Get the updated cart total:
```bash
node "$API" cart "$AUTH"
```

Send a confirmation:
```
mcp__nanoclaw__send_message(text: "✅ *Aggiunti anche:*\n• <product> €<price>\n...\n\n💰 *Nuovo totale: €<total>*\n\n📱 Apri l'app Picnic per scegliere la finestra di consegna e confermare l'ordine.")
```

Update `purchase-history.json` with the newly added items (increment their counts as in Mode 2 Step 7).

---

## Mode 5 — Clear Cart

When user asks "svuota carrello", "clear cart":

```bash
API="/home/node/.claude/skills/picnic-shopping/picnic-api.js"
AUTH="/workspace/group/picnic-shopping/auth.json"

node "$API" clear "$AUTH"
```

Confirm: *"Carrello svuotato!"*

---

## Discount Detection

When searching via API, a product is **discounted** if:
- `discount > 0` (currentPrice < originalPrice)
- `isOffer: true` in the response

**Always prefer discounted products** over full-price equivalents when otherwise a good match.

---

## German Translation Quick Reference (for DE accounts)

| Italian/English | German search term |
|---|---|
| latte intero | vollmilch |
| latte scremato | magermilch |
| uova | eier |
| pane | brot |
| pane integrale | vollkornbrot |
| formaggio | käse |
| parmigiano | parmesan |
| mozzarella | mozzarella |
| pomodori | tomaten |
| mele | äpfel |
| banane | bananen |
| arance | orangen |
| pasta | nudeln / pasta |
| riso | reis |
| burro | butter |
| olio d'oliva | olivenöl |
| zucchero | zucker |
| farina | mehl |
| yogurt | joghurt |
| panna | sahne |
| prosciutto | schinken |
| pollo | hähnchen / hühnchen |
| carne macinata | hackfleisch |
| pesce | fisch |
| salmone | lachs |
| vino rosso | rotwein |
| vino bianco | weißwein |
| birra | bier |
| acqua frizzante | mineralwasser sprudel |
| caffè | kaffee |
| succo d'arancia | orangensaft |
| detersivo | waschmittel / spülmittel |
| carta igienica | toilettenpapier |

For items not in this table, use the Italian/English name directly — Picnic may still find them (especially for international brands).

---

## Error Handling

- **Product not found**: skip it, note in summary, do not fail the entire run
- **Session expired mid-run**: re-login and continue
- **Add to cart failed**: note in summary, try alternative product if obvious
- **Picnic service unavailable**: tell the user to try later
- **Missing credentials**: tell the user to check PICNIC_EMAIL and PICNIC_PASSWORD in .env

---

## Notes

- The auth token in `auth.json` typically lasts several weeks — re-login is automatic when it expires
- The shopping cart persists on Picnic's servers — items added across multiple sessions accumulate
- The user **must confirm the order in the Picnic app** — the agent never touches the checkout/payment flow
- Picnic delivery availability varies by region; if delivery is not available, inform the user
- Always communicate in the same language the user used (Italian, German, English, Dutch, etc.)

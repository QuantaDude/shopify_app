#!/usr/bin/env python3
"""
Build a curated SDL of the Shopify Admin GraphQL API (2026-10) covering the
types used by this app's operations, reconstructed from the official reference
pages at shopify.dev (the public SDL proxy was decommissioned).

Usage: python3 build_shopify_sdl.py > admin-2026-10.graphql
"""
import re
import sys
import time
import urllib.request

BASE = "https://shopify.dev/api/admin-graphql/latest"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"

_cache = {}


def fetch(url: str) -> str:
    if url in _cache:
        return _cache[url]
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", "ignore")
    _cache[url] = html
    time.sleep(0.35)
    return html


def page_text(url: str) -> str:
    html = fetch(url)
    txt = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.S)
    txt = re.sub(r"<style[^>]*>.*?</style>", " ", txt, flags=re.S)
    txt = re.sub(r"<[^>]+>", " ", txt)
    for enc, dec in (
        ("&lpar;", "("), ("&rpar;", ")"), ("&colon;", ":"), ("&comma;", ","),
        ("&nbsp;", " "), ("&amp;", "&"), ("&#x27;", "'"), ("&quot;", '"'),
        ("&lt;", "<"), ("&gt;", ">"),
    ):
        txt = txt.replace(enc, dec)
    return re.sub(r"\s+", " ", txt)


FIELD_RE = re.compile(r"\b([a-zA-Z][A-Za-z0-9_]*)\s*\(([\[\]\w!]+)\)")
DEPRECATED_RE = re.compile(r"\b([a-zA-Z][A-Za-z0-9_]*)\s*\(([\[\]\w!]+)\)\s*:\s*deprecated")


def alphabetical_index(text: str) -> list:
    """The reference pages render an alphabetical index of every field as
    `name (Type)` pairs (case-insensitive order). Find the maximal run."""
    matches = list(FIELD_RE.finditer(text))
    best, cur, prev = [], [], ""
    for m in matches:
        name, typ = m.group(1), m.group(2)
        low = name.lower()
        if not prev or low > prev:
            cur.append((name, typ))
            prev = low
        else:
            if len(cur) > len(best):
                best = cur
            cur, prev = [(name, typ)], low
    if len(cur) > len(best):
        best = cur
    seen, res = set(), []
    for n, t in best:
        if n not in seen:
            seen.add(n)
            res.append((n, t))
    return res


def type_fields(kind: str, name: str, must_contain: list) -> list:
    """All fields of a type = active index + deprecated-fields list."""
    txt = page_text(f"{BASE}/{kind}/{name}")
    idx = dict(alphabetical_index(txt))
    for m in DEPRECATED_RE.finditer(txt):
        if m.group(1) not in idx:
            idx[m.group(1)] = m.group(2)
    missing = [f for f in must_contain if f not in idx]
    if missing:
        print(f"  !! {name}: MISSING {missing}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok {name} ({len(idx)} fields)", file=sys.stderr)
    return list(idx.items())


def field_args(kind: str, name: str) -> list:
    """Query/mutation pages: parse the `Arguments Arguments ...` block.
    The region ends at the first 'Anchor to'. Scraped types already carry
    their own nullability, so no extra '!' is appended."""
    txt = page_text(f"{BASE}/{kind}/{name}")
    i = txt.find("Arguments Arguments")
    if i < 0:
        return []
    j = txt.find("Anchor to", i)
    seg = txt[i : j if j > 0 else i + 800]
    out, seen = [], set()
    for m in FIELD_RE.finditer(seg):
        arg, typ = m.group(1), m.group(2)
        if arg == "Arguments" or arg in seen:
            continue
        seen.add(arg)
        out.append((arg, typ, False))
    return out


def prune_undefined(sdl: str) -> str:
    """Drop fields/args whose types reference undefined types, until stable."""
    def defined_names(text):
        names = set()
        for m in re.finditer(r"^(?:type|input|enum|scalar|interface)\s+(\w+)", text, re.M):
            names.add(m.group(1))
        names.update({"Boolean", "Int", "String", "Float", "ID"})
        return names

    def type_ok(typ, defined):
        for base in re.findall(r"([A-Za-z_]\w*)", re.sub(r"[\[\]!]", " ", typ)):
            if base not in defined:
                return False
        return True

    for _ in range(10):
        defined = defined_names(sdl)
        changed = False
        lines = sdl.split("\n")
        kept = []
        for line in lines:
            m = re.match(r"\s{2}(\w+)(\(([^)]*)\))?:\s*(.+)$", line)
            if m and not line.strip().startswith("#"):
                argstr = m.group(3)
                ret = m.group(4).strip()
                if not type_ok(ret, defined):
                    changed = True
                    continue  # drop field
                if argstr:
                    args = []
                    for part in argstr.split(","):
                        part = part.strip()
                        if not part:
                            continue
                        am = re.match(r"(\w+):\s*(.+)$", part)
                        if not am:
                            continue
                        if type_ok(am.group(2), defined):
                            args.append(part)
                        else:
                            changed = True
                    if args:
                        newline = f"  {m.group(1)}({', '.join(args)}): {ret}"
                    else:
                        newline = f"  {m.group(1)}: {ret}"
                    kept.append(newline)
                else:
                    kept.append(line)
            else:
                kept.append(line)
        sdl = "\n".join(kept)
        if not changed:
            return sdl
    return sdl


def main():
    out = []
    w = out.append

    w("# Curated subset of the Shopify Admin GraphQL API - version 2026-10")
    w("# Reconstructed from the official reference pages at shopify.dev")
    w("# (the public SDL proxy endpoint was decommissioned).")
    w("# Covers the types used by this app's operations; extend as needed.")
    w("# For the full schema, dump introspection from a store endpoint instead:")
    w("#   schema: https://<shop>.myshopify.com/admin/api/2026-10/graphql.json")
    w("")

    # ---------- scalars ----------
    scalars = [
        "DateTime", "HTML", "URL", "Decimal", "JsonString", "MoneyBigDecimal", "Money",
        "CustomerEmailMarketingConsentState", "CustomerSmsMarketingConsentState",
        "UnsignedInt64",
    ]
    for s in scalars:
        w(f"scalar {s}")
    w("")

    # ---------- enums ----------
    w("enum CurrencyCode { USD }")
    w("enum AppRecurringPricingInterval { DAY MONTH YEAR }")
    w("enum WebhookSubscriptionFormat { JSON }")
    w("enum ProductStatus { ACTIVE ARCHIVED DRAFT }")
    w("enum FulfillmentStatus { CANCELLED ERROR FAILURE OPEN PENDING SUCCESS }")
    w("enum AppSubscriptionStatus { ACCEPTED ACTIVE CANCELLED DECLINED EXPIRED PENDING }")
    w("enum OrderCancelReason { CUSTOMER DECLINED FRAUD INVENTORY OTHER }")
    w("enum OrderDisplayFinancialStatus { AUTHORIZED PAID PARTIALLY_PAID PENDING REFUNDED VOIDED }")
    w("enum FulfillmentDisplayStatus { BEFORE ATTEMPTING_DELIVERY CONFIRMED DELIVERED FAILURE FULFILLED IN_TRANSIT LABEL_PRINTED READY_FOR_PICKUP SCHEDULED SUBMITTED UNFULFILLED }")
    w("# CountryCode is truncated here to a representative subset; the field")
    w("# is only selected as a leaf by this app's documents.")
    w("enum CountryCode { AD AE AG AI AL AM AO AR AT AU AW AZ BB BE BF BG BH BI BJ BL BM BN BO BR BS BT BW BY BZ CA CD CG CH CI CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FO FR GA GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MQ MR MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PR PS PT PW PY QA RE RO RS RU RW SA SB SC SE SG SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WS XI YE ZA ZM ZW }")
    w("enum WebhookSubscriptionTopic {")
    for t in ("APP_UNINSTALLED", "APP_SUBSCRIPTIONS_UPDATE", "CUSTOMERS_CREATE",
              "ORDERS_CREATE", "ORDERS_UPDATED", "PRODUCTS_CREATE", "PRODUCTS_DELETE",
              "PRODUCTS_UPDATE", "SHOP_UPDATE", "SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS"):
        w(f"  {t}")
    w("}")
    w("")

    # ---------- fixed leaf/value types ----------
    w("type MoneyV2 { amount: Decimal! currencyCode: CurrencyCode! }")
    w("type Count { count: Int! }")
    w("type PageInfo { hasNextPage: Boolean! hasPreviousPage: Boolean! startCursor: String endCursor: String }")
    w("type Image { id: ID! altText: String url: URL! width: Int height: Int }")
    w("type TaxLine { channelLiable: Boolean priceSet: MoneyBag! rate: Float ratePercentage: Float title: String! }")
    w("type MoneyBag { shopMoney: MoneyV2! presentmentMoney: MoneyV2! }")
    w("type AppPricingPrice { amount: Decimal! currencyCode: CurrencyCode! }")
    w("type ProductOptionValue { id: ID! name: String! hasVariants: Boolean! }")
    w("type SelectedOption { name: String! value: String! }")
    w("type ProductPriceRangeV2 { minVariantPrice: MoneyV2! maxVariantPrice: MoneyV2! }")
    w("type ProductCompareAtPriceRange { minVariantCompareAtPrice: MoneyV2! maxVariantCompareAtPrice: MoneyV2! }")
    w("type FulfillmentTrackingInfo { company: String number: String url: URL }")
    w("")
    w("interface AppPricingDetails { interval: AppRecurringPricingInterval! }")
    w("type AppRecurringPricing implements AppPricingDetails { interval: AppRecurringPricingInterval! price: AppPricingPrice! }")
    w("type AppUsagePricing implements AppPricingDetails { interval: AppRecurringPricingInterval! cappedAmount: Decimal! }")
    w("")

    # ---------- scraped objects ----------
    def object_type(name, must, args_map=None):
        fields = type_fields("objects", name, must)
        w(f"type {name} {{")
        for fname, ftype in fields:
            args = (args_map or {}).get(fname, "")
            w(f"  {fname}{args}: {ftype}")
        w("}")
        w("")

    CONN_ARGS = "(first: Int, after: String, last: Int, before: String, query: String)"
    LOC_ARGS = "(first: Int, after: String, last: Int, before: String, includeInactive: Boolean, includeLegacy: Boolean, query: String, reverse: Boolean)"
    PAGINATED = "(first: Int, after: String, last: Int, before: String, childrenOf: ID)"
    LIST_ARGS = "(first: Int, after: String, last: Int, before: String)"

    object_type("Product",
                ["id", "title", "category", "priceRangeV2", "variantsCount", "totalInventory",
                 "variants", "legacyResourceId", "productType", "tags", "handle", "vendor",
                 "descriptionHtml", "compareAtPriceRange", "status", "updatedAt", "createdAt",
                 "options"],
                args_map={"variants": CONN_ARGS})
    object_type("ProductOption",
                ["id", "name", "optionValues"])
    object_type("ProductVariant",
                ["id", "title", "sku", "price", "displayName", "compareAtPrice",
                 "inventoryQuantity", "inventoryItem", "createdAt", "updatedAt",
                 "selectedOptions"])
    object_type("InventoryItem",
                ["id", "sku", "createdAt", "updatedAt", "inventoryLevels"],
                args_map={"inventoryLevels": LIST_ARGS})
    object_type("Order",
                ["id", "name", "email", "phone", "tags", "createdAt", "updatedAt", "closedAt",
                 "cancelledAt", "cancelReason", "processedAt", "confirmed", "closed",
                 "taxesIncluded", "legacyResourceId", "displayFinancialStatus", "fulfillable",
                 "customerLocale", "hasTimelineComment", "registeredSourceUrl",
                 "subtotalLineItemsQuantity", "lineItems", "fulfillments", "shippingLine",
                 "shippingAddress", "billingAddress", "customer", "totalPriceSet",
                 "subtotalPriceSet", "totalDiscountsSet", "currentSubtotalPriceSet",
                 "currentTaxLines"],
                args_map={"lineItems": CONN_ARGS})
    object_type("LineItem",
                ["id", "quantity", "name", "sku", "title", "vendor", "currentQuantity",
                 "unfulfilledQuantity", "nonFulfillableQuantity", "refundableQuantity",
                 "restockable", "canRestock", "requiresShipping", "merchantEditable",
                 "isGiftCard", "taxable", "taxLines", "originalTotalSet", "image",
                 "product", "variant", "variantTitle"])
    object_type("Fulfillment",
                ["id", "name", "status", "displayStatus", "createdAt", "updatedAt",
                 "deliveredAt", "estimatedDeliveryAt", "inTransitAt", "legacyResourceId",
                 "location", "totalQuantity", "trackingInfo"])
    object_type("ShippingLine",
                ["id", "title", "code", "phone", "custom", "source", "carrierIdentifier",
                 "shippingRateHandle", "originalPriceSet"])
    object_type("MailingAddress",
                ["id", "address1", "address2", "city", "country", "countryCodeV2",
                 "province", "provinceCode", "zip", "phone", "firstName", "lastName",
                 "formatted"])
    object_type("Customer",
                ["id", "firstName", "lastName", "email", "phone", "note", "locale", "tags",
                 "displayName", "createdAt", "updatedAt", "hasTimelineComment", "canDelete",
                 "verifiedEmail", "taxExempt", "defaultAddress", "addresses", "metafields",
                 "smsMarketingConsent", "emailMarketingConsent"],
                args_map={"addresses": "(first: Int)", "metafields": "(first: Int, after: String)"})
    object_type("Metafield",
                ["id", "key", "value", "namespace", "description"])
    object_type("Shop",
                ["id", "name", "email", "myshopifyDomain", "currencyCode", "createdAt",
                 "updatedAt", "billingAddress"])
    object_type("ShopAddress",
                ["address1", "address2", "city", "country", "countryCodeV2",
                 "province", "provinceCode", "zip", "phone", "formatted"])
    object_type("ProductCategory", ["productTaxonomyNode"])
    object_type("ProductTaxonomyNode", ["id", "fullName", "name", "isRoot", "isLeaf"])
    object_type("TaxonomyCategory",
                ["id", "fullName", "name", "isRoot", "isLeaf", "level", "childrenIds",
                 "parentId"])
    object_type("Taxonomy", ["categories"], args_map={"categories": PAGINATED})
    object_type("App", ["installation"])
    object_type("AppInstallation", ["activeSubscriptions"])
    object_type("AppSubscription", ["id", "status", "createdAt", "lineItems"])
    object_type("AppSubscriptionLineItem", ["plan"])
    object_type("AppPlanV2", ["pricingDetails"])
    object_type("WebhookSubscription", ["id", "topic", "endpoint", "format"])
    object_type("InventoryQuantity", ["id", "name", "quantity", "updatedAt"])
    object_type("InventoryLevel", ["id", "location", "quantities"],
                args_map={"quantities": "(names: [String!])"})
    object_type("Location", ["id", "isActive", "name"])

    # ---------- input objects ----------
    def input_type(name, must, args_map=None):
        fields = type_fields("input-objects", name, must)
        w(f"input {name} {{")
        for fname, ftype in fields:
            args = (args_map or {}).get(fname, "")
            w(f"  {fname}{args}: {ftype}")
        w("}")
        w("")

    input_type("ProductCreateInput",
               ["title", "vendor", "descriptionHtml", "productType", "tags", "category"])
    input_type("ProductVariantsBulkInput",
               ["price", "compareAtPrice", "optionValues", "inventoryItem",
                "inventoryQuantities", "barcode"])
    input_type("VariantOptionValueInput", ["name", "optionName", "optionId", "id"])
    input_type("InventoryLevelInput", ["availableQuantity", "locationId"])
    input_type("InventoryItemInput", ["sku", "cost", "tracked", "requiresShipping"])
    input_type("AppSubscriptionLineItemInput", ["plan"])
    input_type("AppPlanInput", ["appRecurringPricingDetails", "appUsagePricingDetails"])
    input_type("AppRecurringPricingInput", ["price", "interval"])
    input_type("MoneyInput", ["amount", "currencyCode"])
    input_type("WebhookSubscriptionInput",
               ["uri", "format", "metafieldNamespaces", "includeFields", "filter"])

    # ---------- connections (standard Shopify shape) ----------
    def connection(name, node, with_nodes=False):
        w(f"type {name}Edge {{ cursor: String! node: {node}! }}")
        body = f"  edges: [{name}Edge!]!"
        if with_nodes:
            body += f"\n  nodes: [{node}!]!"
        body += "\n  pageInfo: PageInfo!"
        w(f"type {name}Connection {{\n{body}\n}}")
        w("")

    connection("Product", "Product")
    connection("ProductVariant", "ProductVariant")
    connection("TaxonomyCategory", "TaxonomyCategory", with_nodes=True)
    connection("Order", "Order")
    connection("LineItem", "LineItem", with_nodes=True)
    connection("Customer", "Customer")
    connection("Metafield", "Metafield")
    connection("InventoryLevel", "InventoryLevel")
    connection("Location", "Location")

    # ---------- root types (scraped args) ----------
    def emit_root(kind, name, fields_spec):
        w(f"type {name} {{")
        pagekind = "queries" if kind == "QueryRoot" else "mutations"
        for fname, ftype, known_args in fields_spec:
            args = known_args if known_args is not None else field_args(pagekind, fname)
            if fname == "productCreate":
                args = [a for a in args if a[0] in ("media", "product")]
            if fname == "productVariantsBulkCreate":
                args = [a for a in args if a[0] in ("media", "productId", "strategy", "variants")]
            if args:
                astr = ", ".join(f"{a}: {t}{'!' if r else ''}" for a, t, r in args)
                w(f"  {fname}({astr}): {ftype}")
            else:
                w(f"  {fname}: {ftype}")
        w("}")
        w("")

    CONN_ROOT_ARGS = [
        ("after", "String", False), ("before", "String", False),
        ("first", "Int", False), ("last", "Int", False),
        ("query", "String", False),
    ]
    emit_root("QueryRoot", "QueryRoot", [
        ("shop", "Shop!", []),
        ("products", "ProductConnection!", CONN_ROOT_ARGS),
        ("orders", "OrderConnection!", CONN_ROOT_ARGS),
        ("customers", "CustomerConnection!", CONN_ROOT_ARGS),
        ("taxonomy", "Taxonomy!", []),
        ("appByKey", "App", None),
        ("locations", "LocationConnection!", [
            ("first", "Int", False), ("after", "String", False), ("last", "Int", False),
            ("before", "String", False), ("includeInactive", "Boolean", False),
            ("includeLegacy", "Boolean", False), ("query", "String", False),
            ("reverse", "Boolean", False),
        ]),
    ])
    emit_root("MutationRoot", "MutationRoot", [
        ("appSubscriptionCreate", "AppSubscriptionCreatePayload!", None),
        ("productCreate", "ProductCreatePayload!", None),
        ("productVariantsBulkCreate", "ProductVariantsBulkCreatePayload!", None),
        ("webhookSubscriptionCreate", "WebhookSubscriptionCreatePayload!", None),
    ])

    # mutation payloads
    w("type UserError { field: [String!]! message: String! }")
    w("type AppSubscriptionCreatePayload { appSubscription: AppSubscription confirmationUrl: URL userErrors: [UserError!]! }")
    w("type ProductCreatePayload { product: Product userErrors: [UserError!]! }")
    w("type ProductVariantsBulkCreatePayload { productVariants: [ProductVariant!]! userErrors: [UserError!]! }")
    w("type WebhookSubscriptionCreatePayload { webhookSubscription: WebhookSubscription userErrors: [UserError!]! }")
    w("")
    w("schema { query: QueryRoot mutation: MutationRoot }")
    w("")

    sdl = prune_undefined("\n".join(out))
    print(sdl)


if __name__ == "__main__":
    main()

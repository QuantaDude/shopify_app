import * as process from 'node:process';

export default () => ({
  environment: process.env.NODE_ENV || 'production',

  port: parseInt(process.env.PORT, 10) || 3000,
  logging: process.env.LOGGING,
  logToFile: process.env.LOG_TO_FILE,

  app_secret: process.env.APP_SECRET,
  app_url: process.env.APP_URL,
  app_install_URL: `${process.env.APP_URL}/shopify/auth/redirect`,
  refresh_token_URL: `${process.env.APP_URL}/shopify/auth/updateStoreToken`,

  shopify_api_version: process.env.API_VERSION ?? '2026-10',
  shopify_api_key: process.env.API_KEY,
  shopify_api_secret: process.env.API_SECRET,
  //shopify_api_scopes: 'read_products,write_products,read_orders,write_orders',
  shopify_app_embedded: process.env.SHOPIFY_APP_EMBEDDED === 'true',

  // Only send `test: true` to appSubscriptionCreate while opted in.
  // Shopify rejects test charges on production stores.
  billing_test_mode: process.env.BILLING_TEST_MODE !== 'false',

  accessScopes: [
    'read_locations',
    'read_products',
    'write_products',
    'read_orders',
    'read_all_orders',
    'write_orders',
    'read_customers',
    'write_customers',
    'read_returns',
    'read_inventory',
    'write_inventory',
    //'read_marketplace_fulfillment_orders',
    'read_fulfillments',
    'write_fulfillments',
    'read_assigned_fulfillment_orders',
    'read_merchant_managed_fulfillment_orders',
    'read_third_party_fulfillment_orders',
  ].join(','),

  jwt_secret: process.env.JWT_SECRET ?? 'randomstring',
  jwt_token_audience: process.env.JWT_TOKEN_AUDIENCE ?? 'https://3ebe-223-233-67-231.ngrok-free.app',
  jwt_token_issuer: process.env.JWT_TOKEN_ISSUER,
  jwt_access_token_ttl: parseInt(process.env.JWT_ACCESS_TOKEN_TTL ?? '3600', 10),

  database: {
    host: process.env.DB_HOST ?? 'localhost',
    // PostgreSQL is the only supported DB_TYPE; default port 5432
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    type: (process.env.DB_TYPE as any) ?? 'postgres',
    name: process.env.DB_NAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD ?? '',
    synchronize: process.env.DB_SYNC === 'true',
    autoload: process.env.DB_AUTOLOAD === 'true',
    runMigrationsOnStart: process.env.DB_RUN_MIGRATIONS === 'true',
  },

  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },

  webhooks: [
    'orders/create',
    'orders/updated',
    'products/create',
    'products/update',
    'products/delete',
    'app_subscriptions/update',
    'subscription_billing_attempts/success',
    'app/uninstalled',
    'shop/update',
    'customers/create',
  ],
});

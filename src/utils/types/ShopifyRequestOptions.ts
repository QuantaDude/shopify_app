import { AxiosHeaders } from 'axios';

/**
 * TS 6 + nodenext resolves axios' CJS typing (`export =`) in a way that only
 * allows `AxiosHeaders` as a value, so derive the instance type locally.
 */
export type ShopifyHeaders = InstanceType<typeof AxiosHeaders>;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface ShopifyRequestOptions {
  data?: Record<string, JsonValue> | string | object;
  url: string;
  headers: ShopifyHeaders;
}

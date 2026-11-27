import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { QueryParams } from '../api/client.js';
import { requestTool } from './api-tool.js';

// Web-only product catalog endpoints; not part of the desktop-app catalog.
const PRODUCT_FILTER_PATH = '/api/editor/product/filter';
const PRODUCT_LIST_PATH = '/api/editor/product/list';
const PRODUCT_SEARCH_PATH = '/api/editor/product/search';
const PRODUCT_TREE_PATH = '/api/editor/product/tree';

const productQuerySchema = z.looseObject({
  pageNum: z.number().int().min(1).describe('1-based page number.'),
  pageSize: z.number().int().min(1).describe('Page size.'),
  catalog: z.string().describe('Catalog filter, passed through unchanged.'),
  param: z.string().describe('Filter parameter, passed through unchanged.'),
  keyword: z.string().describe('Search keyword.'),
  piceSort: z.string().describe('Price sort, passed through unchanged (API spelling).'),
  stockSort: z.string().describe('Stock sort, passed through unchanged.'),
});

const productSearchSchema = z.looseObject({
  pageNum: z.number().int().min(1).describe('1-based page number.'),
  pageSize: z.number().int().min(1).describe('Page size.'),
  keyword: z.string().describe('Search keyword.'),
});

const productTreeSchema = z.looseObject({});

export const GET_PRODUCT_FILTERS_TOOL = {
  name: 'jlc_ecad_get_product_filters',
  title: 'Get product filter options',
  description:
    'Read the JLC EDA product catalog filter options with GET /api/editor/product/filter. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: productQuerySchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const LIST_PRODUCTS_TOOL = {
  name: 'jlc_ecad_list_products',
  title: 'List products (GET)',
  description:
    'List JLC EDA product catalog entries with GET /api/editor/product/list, passing the query in the URL. ' +
    'Use jlc_ecad_list_products_post to search by keyword with POST /api/editor/product/search. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: productQuerySchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const LIST_PRODUCTS_POST_TOOL = {
  name: 'jlc_ecad_list_products_post',
  title: 'List products (POST)',
  description:
    'Search JLC EDA product catalog entries with POST /api/editor/product/search, sending pageNum, pageSize, and keyword as a JSON body. ' +
    'Returns the raw JSON response from the editor backend.',
  inputSchema: productSearchSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const GET_PRODUCT_TREE_TOOL = {
  name: 'jlc_ecad_get_product_tree',
  title: 'Get product category tree',
  description:
    'Read the JLC EDA product category tree with GET /api/editor/product/tree. ' + 'Returns the raw JSON response from the editor backend.',
  inputSchema: productTreeSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export async function handleGetProductFilters(args: z.infer<typeof productQuerySchema>): Promise<CallToolResult> {
  return requestTool(GET_PRODUCT_FILTERS_TOOL.name, {
    method: 'GET',
    path: PRODUCT_FILTER_PATH,
    query: productQuery(args),
  });
}

export async function handleListProducts(args: z.infer<typeof productQuerySchema>): Promise<CallToolResult> {
  return requestTool(LIST_PRODUCTS_TOOL.name, {
    method: 'GET',
    path: PRODUCT_LIST_PATH,
    query: productQuery(args),
  });
}

export async function handleListProductsPost(args: z.infer<typeof productSearchSchema>): Promise<CallToolResult> {
  return requestTool(LIST_PRODUCTS_POST_TOOL.name, {
    method: 'POST',
    path: PRODUCT_SEARCH_PATH,
    body: {
      pageNum: args.pageNum,
      pageSize: args.pageSize,
      keyword: args.keyword,
    },
  });
}

export async function handleGetProductTree(): Promise<CallToolResult> {
  return requestTool(GET_PRODUCT_TREE_TOOL.name, { method: 'GET', path: PRODUCT_TREE_PATH });
}

function productQuery(args: z.infer<typeof productQuerySchema>): QueryParams {
  return {
    pageNum: args.pageNum,
    pageSize: args.pageSize,
    catalog: args.catalog,
    param: args.param,
    keyword: args.keyword,
    piceSort: args.piceSort,
    stockSort: args.stockSort,
  };
}

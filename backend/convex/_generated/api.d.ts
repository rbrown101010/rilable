/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as android from "../android.js";
import type * as auth from "../auth.js";
import type * as builder from "../builder.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as iosTemplate from "../iosTemplate.js";
import type * as messages from "../messages.js";
import type * as models from "../models.js";
import type * as projects from "../projects.js";
import type * as voice from "../voice.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  android: typeof android;
  auth: typeof auth;
  builder: typeof builder;
  files: typeof files;
  http: typeof http;
  iosTemplate: typeof iosTemplate;
  messages: typeof messages;
  models: typeof models;
  projects: typeof projects;
  voice: typeof voice;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};

import type { Hono } from "hono";
import type { AppEnv } from "../http/middleware.js";

export type AppType = Hono<AppEnv>;

import { z } from "zod";
import { isId } from "./ids.js";

export const IdSchema = z.string().refine(isId, "invalid id");

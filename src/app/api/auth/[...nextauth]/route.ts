import { handlers } from "@/lib/auth";

// Auth.js v5 catch-all OAuth + credentials callback route.
// `handlers` already exposes typed GET and POST.
export const { GET, POST } = handlers;

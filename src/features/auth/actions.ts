"use server";

import bcrypt from "bcryptjs";
import { AuthError } from "next-auth";
import { z } from "zod";

import { signIn } from "@/lib/auth";
import { getPrisma } from "@/lib/prisma";

export interface ActionResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
}

const signupSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(80),
    email: z.string().email("Enter a valid email").max(254),
    password: z
      .string()
      .min(8, "At least 8 characters")
      .max(128, "Too long")
      .regex(/[A-Za-z]/, "Must contain a letter")
      .regex(/[0-9]/, "Must contain a number"),
  })
  .strict();

const loginSchema = z.object({
  email: z.string().email("Enter a valid email").max(254),
  password: z.string().min(1, "Required").max(128),
});

function formToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    obj[key] = typeof value === "string" ? value : value.name;
  }
  return obj;
}

export async function signupAction(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const parsed = signupSchema.safeParse(formToObject(formData));
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { name, email, password } = parsed.data;
  const prisma = getPrisma();
  const emailLower = email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email: emailLower }, select: { id: true } });
  if (existing) {
    return { ok: false, error: "An account with that email already exists." };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: {
      email: emailLower,
      name,
      passwordHash,
      setting: { create: {} },
    },
  });

  // Sign the user in immediately. `redirectTo: "/"` sends them to the dashboard
  // after Auth.js issues the session cookie.
  try {
    await signIn("credentials", { email: emailLower, password, redirectTo: "/" });
  } catch (err) {
    // `signIn` always throws a NEXT_REDIRECT — re-throw so Next handles it.
    if (isRedirectError(err)) throw err;
    return { ok: false, error: "Account created — but auto-login failed. Try signing in." };
  }
  return { ok: true };
}

export async function loginAction(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const parsed = loginSchema.safeParse(formToObject(formData));
  if (!parsed.success) {
    return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { email, password } = parsed.data;
  try {
    await signIn("credentials", {
      email: email.toLowerCase(),
      password,
      redirectTo: "/",
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof AuthError) {
      return { ok: false, error: "Invalid email or password." };
    }
    return { ok: false, error: "Could not sign in. Try again." };
  }
  return { ok: true };
}

/**
 * Next.js encodes redirects as a thrown error with `digest` starting with
 * `NEXT_REDIRECT`. Re-throw so the framework converts it into the actual
 * HTTP redirect response — swallowing it would strand the user.
 */
function isRedirectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const digest = (err as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

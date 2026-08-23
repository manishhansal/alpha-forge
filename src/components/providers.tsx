"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";

import { ThemeProvider } from "@/components/theme-provider";
import { CommandPaletteProvider } from "@/components/dashboard/command-palette";

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15 * 1000,
            gcTime: 5 * 60 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <CommandPaletteProvider>
          {children}
          {/* Sonner toast portal — theme-aware via CSS vars */}
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: "var(--bg-elevated)",
                border: "1px solid var(--border-strong)",
                color: "var(--fg)",
                borderRadius: "0.875rem",
                fontSize: "13px",
              },
            }}
            richColors
            closeButton
          />
        </CommandPaletteProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

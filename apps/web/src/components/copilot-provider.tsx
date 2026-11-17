"use client";

import { CopilotKit } from "@copilotkit/react-core";

const runtimeUrl = process.env.NEXT_PUBLIC_COPILOTKIT_RUNTIME_URL || "/api/openpong/copilotkit";

/**
 * One CopilotKit runtime for every route. `runtimeUrl` defaults to the same-origin
 * BFF proxy, which forwards to the OpenPong server (http://localhost:8787/api/copilotkit)
 * with the bearer token held server-side.
 */
export function OpenPongCopilotProvider({ children }: { children: React.ReactNode }) {
  return (
    <CopilotKit runtimeUrl={runtimeUrl} showDevConsole={false} agent="default">
      {children}
    </CopilotKit>
  );
}

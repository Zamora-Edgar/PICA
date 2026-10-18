import "dotenv/config";

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined || value === "" ? fallback : value === "true";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",

  // 🔌 PHOTON 2.0 — credentials from the Photon dashboard.
  photon: {
    apiBase: process.env.PHOTON_API_BASE ?? "https://api.photon.example/v2",
    apiKey: process.env.PHOTON_API_KEY ?? "",
    projectId: process.env.PHOTON_PROJECT_ID ?? "",
    agentHandle: process.env.PHOTON_AGENT_HANDLE ?? "",
    webhookSecret: process.env.PHOTON_WEBHOOK_SECRET ?? "",
    voiceNumber: process.env.PHOTON_VOICE_NUMBER ?? "",
    voiceProfileId: process.env.PHOTON_VOICE_PROFILE_ID ?? "",
    mock: bool(process.env.PHOTON_MOCK, true),
  },

  // 🔌 VISA INTELLIGENT COMMERCE — credentials from the Visa Developer Center project.
  visa: {
    apiBase: process.env.VISA_API_BASE ?? "https://sandbox.api.visa.com",
    userId: process.env.VISA_USER_ID ?? "",
    password: process.env.VISA_PASSWORD ?? "",
    mock: bool(process.env.VISA_MOCK, true),
  },

  // Any OpenAI-compatible endpoint (OpenAI, or Gemini via its OpenAI-compatible base URL).
  llm: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.LLM_MODEL || "gpt-4o",
    baseURL: process.env.LLM_BASE_URL || undefined,
  },

  approvalTtlMinutes: Number(process.env.APPROVAL_TTL_MINUTES ?? 30),
  historyLimit: 30, // messages of shared cross-channel history fed to the agent
};

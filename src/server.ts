import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { config } from "./config";
import { apiRouter } from "./routes/api";
import { photonWebhookRouter, handleInboundMessage } from "./webhooks/photonWebhook";
import { startPhotonPolling } from "./integrations/photon";

const app = express();

app.use(photonWebhookRouter); // mounted first: it needs the raw body for signature checks
app.use(express.static("public"));
app.use("/api", apiRouter);
app.get("/health", (_req, res) => res.json({ ok: true, photonMock: config.photon.mock, visaMock: config.visa.mock }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: "Invalid request", issues: err.issues });
  console.error(err);
  res.status(500).json({ error: "Internal error" });
});

app.listen(config.port, () => {
  console.log(`TripSync listening on :${config.port} (photon ${config.photon.mock ? "MOCK" : "LIVE"}, visa ${config.visa.mock ? "MOCK" : "LIVE"})`);
  startPhotonPolling(handleInboundMessage);
});

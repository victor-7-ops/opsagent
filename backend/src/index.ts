import express from "express";
import dotenv from "dotenv";
import healthRouter from "./routes/health";
import hubspotRouter from "./routes/hubspot";
import webhooksRouter from "./routes/webhooks";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }),
);
app.use(healthRouter);
app.use(hubspotRouter);
app.use(webhooksRouter);

app.listen(port, () => {
  console.log(`OpsAgent backend listening on port ${port}`);
});
